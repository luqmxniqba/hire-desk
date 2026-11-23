// Tests the database rules on a local Postgres with a Supabase stand-in.
// Run: node tests/sql.test.mjs   (needs the local Postgres from tests/README)
import pg from 'pg';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const base = {host: process.env.PGHOST || '/tmp/pg', port: +(process.env.PGPORT || 54322), user: 'postgres'};
const DB = process.env.TEST_DB || 'hiresql';

async function fresh(){
  const admin = new pg.Client({...base, database: 'postgres'});
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
  await admin.end();
  const c = new pg.Client({...base, database: DB});
  await c.connect();
  await c.query(fs.readFileSync(new URL('./supabase_stub.sql', import.meta.url), 'utf8'));
  await c.query(fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  return c;
}

const c = await fresh();
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };

async function user(email, confirmed = true){
  const r = await c.query('insert into auth.users (email, email_confirmed_at) values ($1, $2) returning id', [email, confirmed ? new Date() : null]);
  return {id: r.rows[0].id, email};
}
// Run fn as a signed-in user (or anon when u is null), like the API does.
async function as(u, fn){
  await c.query('begin');
  try {
    await c.query(`set local role ${u ? 'authenticated' : 'anon'}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(u ? {sub: u.id, role: 'authenticated', email: u.email} : {role: 'anon'})]);
    const out = await fn((q, p) => c.query(q, p));
    await c.query('commit');
    return out;
  } catch (e) { await c.query('rollback'); throw e; }
}
async function fails(u, fn, re){
  try { await as(u, fn); } catch (e) { ok(re.test(e.message), 'expected error ' + re + ' got ' + e.message); return; }
  assert.fail('expected an error matching ' + re);
}
const rpc = async (u, name, args) => (await as(u, q => q(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as r`, args))).rows[0].r;

const alice = await user('alice@example.com');
const bob = await user('bob@example.com');
const eve = await user('eve@example.com');
const carol = await user('carol@example.com');
const una = await user('una@example.com', false);

// --- setting up a business
eq((await rpc(alice, 'create_business', ['Alpha Hire', 'alpha-hire', 'CHANGE-ME'])).error, 'setup_closed', 'closed until a code is set');
await c.query(`update public.app_config set value = 'sesame-123' where key = 'signup_code'`);
eq((await rpc(eve, 'create_business', ['X', 'xxx', 'wrong'])).error, 'bad_code', 'wrong code refused');
for (let i = 0; i < 9; i++) await rpc(eve, 'create_business', ['X', 'xxx', 'wrong' + i]);
eq((await rpc(eve, 'create_business', ['X', 'xxx', 'sesame-123'])).error, 'rate_limited', 'too many wrong codes locks out for an hour');
eq((await rpc(alice, 'create_business', ['Alpha', 'staff', 'sesame-123'])).error, 'bad_slug', 'reserved address refused');
eq((await rpc(alice, 'create_business', ['Alpha', 'Has Spaces', 'sesame-123'])).error, 'bad_slug', 'bad address refused');
const a1 = await rpc(alice, 'create_business', ['Alpha Hire', 'alpha-hire', 'sesame-123']);
ok(a1.ok && a1.id, 'business created');
const ORG = a1.id;
eq((await rpc(carol, 'create_business', ['Copy', 'alpha-hire', 'sesame-123'])).error, 'slug_taken', 'address taken');
const c1 = await rpc(carol, 'create_business', ['Carol Cars', 'carol-cars', 'sesame-123']);
const ORG2 = c1.id;
await fails(null, q => q(`select public.create_business('a','abc','sesame-123')`), /permission denied/);

const mine = await as(alice, q => q('select * from public.my_businesses()'));
eq(mine.rows.map(r => [r.slug, r.role]), [['alpha-hire', 'owner']], 'my businesses');

// --- records: members only
await as(alice, q => q(`insert into public.records (org_id, col, id, data) values ($1, 'cars', 'c1', '{"plate":"AB12 CDE"}')`, [ORG]));
const row = (await c.query(`select updated_by, deleted from public.records where org_id = $1 and id = 'c1'`, [ORG])).rows[0];
eq(row.updated_by, alice.id, 'updated_by is set by the database');
await as(alice, q => q(`update public.records set updated_by = $2 where org_id = $1 and id = 'c1'`, [ORG, eve.id]));
eq((await c.query(`select updated_by from public.records where org_id = $1 and id = 'c1'`, [ORG])).rows[0].updated_by, alice.id, 'updated_by cannot be faked');
eq((await as(eve, q => q(`select * from public.records where org_id = $1`, [ORG]))).rowCount, 0, 'outsider sees nothing');
await fails(eve, q => q(`insert into public.records (org_id, col, id, data) values ($1, 'cars', 'x', '{}')`, [ORG]), /row-level security/);
eq((await as(eve, q => q(`update public.records set data = '{}' where org_id = $1`, [ORG]))).rowCount, 0, 'outsider cannot change');
await fails(alice, q => q(`insert into public.records (org_id, col, id, data) values ($1, 'cars', 'x', '{}')`, [ORG2]), /row-level security/);
await fails(alice, q => q(`delete from public.records where org_id = $1`, [ORG]), /permission denied/);
await fails(alice, q => q(`insert into public.records (org_id, col, id, data) values ($1, 'Bad Col', 'x', '{}')`, [ORG]), /records_col_format/);
// upsert the way the app does it
await as(alice, q => q(`insert into public.records (org_id, col, id, data, deleted) values ($1, 'cars', 'c1', '{"plate":"NEW"}', false)
  on conflict (org_id, col, id) do update set data = excluded.data, deleted = excluded.deleted`, [ORG]));
eq((await c.query(`select data from public.records where org_id = $1 and id = 'c1'`, [ORG])).rows[0].data, {plate: 'NEW'}, 'upsert works');
await as(alice, q => q(`update public.records set deleted = true where org_id = $1 and id = 'c1'`, [ORG]));
eq((await c.query(`select data, deleted from public.records where org_id = $1 and id = 'c1'`, [ORG])).rows[0], {data: {}, deleted: true}, 'deleting empties the record');

// --- team
eq((await rpc(bob, 'invite_member', [ORG, 'eve@example.com', 'staff'])).error, 'not_owner', 'only owners invite');
eq((await rpc(alice, 'invite_member', [ORG, 'not an email', 'staff'])).error, 'bad_email', 'bad email refused');
eq((await rpc(alice, 'invite_member', [ORG, 'Bob@Example.com ', 'staff'])).ok, true, 'invite sent');
eq((await rpc(alice, 'invite_member', [ORG, 'una@example.com', 'staff'])).ok, true, 'invite for unconfirmed');
eq(await rpc(una, 'claim_invites', []), 0, 'unconfirmed email cannot claim an invite');
eq((await as(bob, q => q(`select * from public.records where org_id = $1`, [ORG]))).rowCount, 0, 'not on the team until claimed');
eq(await rpc(bob, 'claim_invites', []), 1, 'invite claimed');
eq((await as(bob, q => q(`select id from public.records where org_id = $1`, [ORG]))).rowCount, 1, 'team member can read');
await as(bob, q => q(`insert into public.records (org_id, col, id, data) values ($1, 'bookings', 'b1', '{"ref":"AB12"}')`, [ORG]));
ok(true, 'staff can write');
const tAlice = await rpc(alice, 'team', [ORG]);
eq(tAlice.members.length, 2, 'owner sees team'); eq(tAlice.invites.map(i => i.email), ['una@example.com'], 'owner sees invites');
const tBob = await rpc(bob, 'team', [ORG]);
eq(tBob.invites, [], 'staff do not see invites');
eq((await rpc(eve, 'team', [ORG])).error, 'not_member', 'outsider cannot see team');
eq((await rpc(bob, 'remove_member', [ORG, alice.id])).error, 'not_owner', 'staff cannot remove the owner');
eq((await rpc(alice, 'remove_member', [ORG, alice.id])).error, 'last_owner', 'last owner cannot leave');
eq((await rpc(alice, 'set_member_role', [ORG, alice.id, 'staff'])).error, 'last_owner', 'last owner cannot step down');
eq((await rpc(alice, 'set_member_role', [ORG, bob.id, 'owner'])).ok, true, 'promote to owner');
eq((await rpc(alice, 'set_member_role', [ORG, bob.id, 'staff'])).ok, true, 'back to staff');
eq((await rpc(alice, 'invite_member', [ORG, 'bob@example.com', 'staff'])).error, 'already_member', 'already on the team');
await fails(bob, q => q(`insert into public.members (org_id, user_id, role) values ($1, $2, 'owner')`, [ORG, eve.id]), /permission denied/);
await fails(eve, q => q(`select * from public.app_config`), /permission denied/);
eq((await as(eve, q => q(`select * from public.members where org_id = $1`, [ORG]))).rowCount, 0, 'outsider cannot list members');

// --- customer pages (no sign-in)
await fails(null, q => q(`select * from public.records`), /permission denied/);
await fails(null, q => q(`select * from public.orgs`), /permission denied/);
eq(await rpc(null, 'public_page', ['nope']), null, 'unknown business');
eq((await rpc(null, 'public_page', ['alpha-hire'])).page, null, 'no page published yet');
const msg = 'BOOKING REQUEST\nCar: Audi A3\nName: Sam\nMobile: 07700 900123\nRef: k1 2026-12-01T10:00 2026-12-02T10:00';
eq((await rpc(null, 'submit_inbox', ['alpha-hire', 'booking', msg, 'Sam', '07700 900123', ''])).error, 'page_off', 'page off refuses requests');
eq((await rpc(null, 'submit_inbox', ['alpha-hire', 'details', 'BOOKING DETAILS · ref AB12\nName: Sam', 'Sam', '07700 900123', 'AB12'])).ok, true, 'hire details form works even when the page is off');
await as(alice, q => q(`insert into public.records (org_id, col, id, data) values ($1, 'public', 'availability', '{"on": true, "cars": [{"id": "k1"}]}')`, [ORG]));
eq((await rpc(null, 'public_page', ['Alpha-Hire'])).page.cars, [{id: 'k1'}], 'published page readable');
eq((await rpc(null, 'submit_inbox', ['alpha-hire', 'spam', msg, '', '', ''])).error, 'invalid', 'unknown kind refused');
eq((await rpc(null, 'submit_inbox', ['alpha-hire', 'booking', 'short', '', '', ''])).error, 'invalid', 'too short refused');
eq((await rpc(null, 'submit_inbox', ['alpha-hire', 'booking', msg, 'Sam', '07700 900123', ''])).ok, true, 'request accepted');
const inbox = await as(alice, q => q(`select data from public.records where org_id = $1 and col = 'inbox' order by updated_at`, [ORG]));
eq(inbox.rowCount, 2, 'owner sees inbox');
eq(inbox.rows[1].data.kind, 'booking', 'kind stored'); eq(inbox.rows[0].data.ref, 'AB12', 'ref stored');
eq((await as(eve, q => q(`select * from public.records where col = 'inbox'`))).rowCount, 0, 'outsider sees no inbox');
for (let i = 0; i < 4; i++) await rpc(null, 'submit_inbox', ['alpha-hire', 'booking', msg, 'Sam', '+44 7700 900123', '']);
eq((await rpc(null, 'submit_inbox', ['alpha-hire', 'booking', msg, 'Sam', '07700900123', ''])).error, 'rate_limited', 'same phone limited to 6 an hour');
eq((await rpc(null, 'submit_inbox', ['carol-cars', 'booking', msg, 'Sam', '07700900123', ''])).error, 'page_off', 'limits are per business');
await fails(null, q => q(`select public.team($1)`, [ORG]), /permission denied/);
await fails(null, q => q(`select app.can_read($1)`, [ORG]), /permission denied/);

// --- photo storage
await as(alice, q => q(`insert into storage.objects (bucket_id, name) values ('assets', $1)`, [ORG + '/p1.jpg']));
eq((await as(bob, q => q(`select name from storage.objects`))).rowCount, 1, 'team sees its photos');
eq((await as(eve, q => q(`select name from storage.objects`))).rowCount, 0, 'outsider sees no photos');
await fails(eve, q => q(`insert into storage.objects (bucket_id, name) values ('assets', $1)`, [ORG + '/p2.jpg']), /row-level security/);
await fails(alice, q => q(`insert into storage.objects (bucket_id, name) values ('assets', 'not-a-uuid/p.jpg')`), /row-level security/);
await fails(alice, q => q(`insert into storage.objects (bucket_id, name) values ('other', $1)`, [ORG + '/p.jpg']), /row-level security|foreign key/);
eq((await as(eve, q => q(`delete from storage.objects`))).rowCount, 0, 'outsider cannot delete photos');

// --- removed from the team means locked out
eq((await rpc(alice, 'remove_member', [ORG, bob.id])).ok, true, 'owner removes staff');
eq((await as(bob, q => q(`select * from public.records where org_id = $1`, [ORG]))).rowCount, 0, 'removed member sees nothing');
eq((await as(bob, q => q(`select name from storage.objects`))).rowCount, 0, 'removed member sees no photos');

await c.end();
console.log('SQL tests passed:', passed);
