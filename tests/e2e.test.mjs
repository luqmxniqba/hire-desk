// End-to-end: owner sets up a business, brings in data, opens the booking page;
// a customer requests a car and sends hire details; staff join; outsiders are kept out.
// Runs in Chrome against tests/harness.mjs (local Postgres + Supabase stand-in).
import {chromium} from 'playwright-core';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {startHarness} from './harness.mjs';

const SHOTS = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, {recursive: true});
const log = (...a) => console.log('·', ...a);
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; log('ok', m); };

const H = await startHarness({port: 8090, db: 'hiree2e', pollMs: 1500});
const B = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox']});
const errors = [];
async function newPage(name, opts = {}) {
  const ctx = await B.newContext({viewport: opts.mobile ? {width: 390, height: 844} : {width: 1280, height: 860}, acceptDownloads: true, deviceScaleFactor: opts.mobile ? 2 : 1, hasTouch: !!opts.mobile, isMobile: !!opts.mobile});
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/WebSocket|realtime|ERR_CONNECTION|favicon/i.test(m.text())) errors.push(name + ': ' + m.text()); });
  page.on('pageerror', e => errors.push(name + ' pageerror: ' + e.message));
  return page;
}
const shot = (page, n) => page.screenshot({path: SHOTS + n + '.png'});
const O = H.origin;

try {
  /* ---- 1. Demo copy works and gives us a backup full of example data ---- */
  const demo = await newPage('demo');
  await demo.goto(O + '/staff?demo#setup');
  await demo.waitForSelector('[data-act="backup"]');
  const [dl] = await Promise.all([demo.waitForEvent('download'), demo.click('[data-act="backup"]')]);
  const backupPath = SHOTS + 'backup.json';
  await dl.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  ok(backup.app === 'car-hire-tracker' && backup.cars.length > 3, 'demo backup downloads (' + backup.cars.length + ' cars, ' + backup.bookings.length + ' bookings)');
  await demo.close();

  /* ---- 2. Owner signs up and sets up the business ---- */
  const own = await newPage('owner');
  await own.goto(O + '/staff');
  await own.waitForSelector('#pf-gate h1:has-text("Sign in")');
  await shot(own, '01-sign-in');
  await own.click('#pf-go-up');
  await own.fill('#pf-su [name=name]', 'Ayaan Khan');
  await own.fill('#pf-su [name=email]', 'owner@test.dev');
  await own.fill('#pf-su [name=password]', 'correct-horse-1');
  await own.click('#pf-su button[type=submit]');
  await own.waitForSelector('#pf-gate h1:has-text("signed in")');
  await own.click('details.pf-d summary');
  await own.fill('#pf-nb [name=name]', 'Test Hire');
  ok(await own.inputValue('#pf-nb [name=slug]') === 'test-hire', 'page address fills itself from the name');
  await own.fill('#pf-nb [name=code]', 'wrong-code');
  await own.click('#pf-nb button[type=submit]');
  await own.waitForSelector('#pf-err:not([hidden])');
  ok((await own.textContent('#pf-err')).includes('isn’t right'), 'wrong setup code is refused');
  await shot(own, '02-setup-business');
  await own.fill('#pf-nb [name=code]', 'open-sesame');
  await own.click('#pf-nb button[type=submit]');
  await own.waitForSelector('#pf-gate', {state: 'detached'});
  await own.waitForSelector('text=Add your cars to get started');
  ok(true, 'business created, empty tracker opens');
  ok((await own.textContent('#bizname')) === 'Test Hire', 'business name in the header');

  /* ---- 3. Restore the backup into the live business ---- */
  await own.goto(O + '/staff#setup');
  await own.waitForSelector('#restore-file', {state: 'attached'});
  await own.setInputFiles('#restore-file', backupPath);
  await own.click('[data-act="dlg-yes"]');
  await own.waitForSelector('text=Backup restored', {timeout: 60000});
  const n = (await H.pool.query(`select count(*)::int as n from public.records where col <> 'settings'`)).rows[0].n;
  const expected = ['cars', 'customers', 'bookings', 'fines', 'expenses', 'damage', 'leads', 'vouchers', 'promos', 'incidents', 'owners', 'cashbook'].reduce((a, c) => a + (backup[c] || []).length, 0);
  ok(n >= expected, `backup restored into the database (${n} records, ${expected} expected)`);
  const st = (await H.pool.query(`select data from public.records where col = 'settings' and id = 'main'`)).rows[0].data;
  ok(!/claude\.ai/.test(JSON.stringify(st)), 'restored settings have no Claude links');

  // business details + switch the booking page on
  await own.goto(O + '/staff#setup');
  await own.fill('#s-name', 'Test Hire');
  await own.fill('#s-phone', '07700 900000');
  await own.click('form[data-form="set-biz"] button.primary');
  await own.waitForTimeout(600);
  await own.click('[data-act="pub-on"]');
  await own.waitForSelector('text=Your page is live');
  await shot(own, '03-setup-page-live');
  // availability is published a few seconds after a change
  let page = null;
  for (let i = 0; i < 30 && !page; i++) { await own.waitForTimeout(500); page = (await H.pool.query(`select data from public.records where col = 'public' and id = 'availability'`)).rows[0]; }
  ok(page && page.data.on === true && page.data.cars.length > 0, 'availability published for the booking page (' + (page && page.data.cars.length) + ' cars)');
  ok(!/"phone"\s*:\s*"07\d|@|licence/i.test(JSON.stringify(page.data.busy)) && !JSON.stringify(page.data).includes(backup.customers[0].name), 'published page has no customer names or details');

  // reload: still signed in, data comes back from the database
  await own.goto(O + '/staff#bookings');
  await own.waitForSelector('#pf-gate', {state: 'detached'});
  await own.waitForSelector('.row');
  ok(true, 'reload keeps you signed in and loads records from the database');
  await shot(own, '04-bookings');

  /* ---- 4. A customer books from their phone ---- */
  const cus = await newPage('customer', {mobile: true});
  await cus.goto(O + '/test-hire');
  await cus.waitForSelector('#grid article.car');
  await shot(cus, '05-booking-page');
  const reqBtn = cus.locator('[data-req]:not([disabled])').first();
  ok(await reqBtn.count() === 1, 'customer sees free cars with prices');
  await reqBtn.click();
  await cus.waitForSelector('#send-direct');
  await cus.fill('#r-name', 'Sam Customer');
  await cus.fill('#r-phone', '07700 900123');
  await cus.fill('#r-dob', '1996-04-12');
  await shot(cus, '06-request-form');
  await cus.click('#send-direct');
  await cus.waitForSelector('#r-done:not([hidden]) h3:has-text("Request sent")');
  await shot(cus, '07-request-sent');
  ok(true, 'booking request sent straight from the page');

  const det = await newPage('details', {mobile: true});
  await det.goto(O + '/test-hire/details#AB12-447700900000-Test-Hire');
  await det.waitForSelector('#send:not([hidden])');
  await det.fill('#name', 'Sam Customer'); await det.fill('#dob', '1996-04-12'); await det.fill('#phone', '07700 900123');
  await det.fill('#address', '1 Test Street, Bradford'); await det.fill('#postcode', 'bd1 1aa'); await det.fill('#lic', 'CUSTO904126SA9AB');
  await det.click('#send');
  await det.waitForSelector('#done:not([hidden]) h2:has-text("Sent")');
  await shot(det, '08-details-sent');
  ok(true, 'hire details form sends straight to the business');

  // the public API can't read anything else
  const anon = await cus.evaluate(async () => {
    const c = window.APP_CONFIG; const h = {apikey: c.supabaseKey};
    const a = await fetch(c.supabaseUrl + '/rest/v1/records?select=*', {headers: h});
    const b = await fetch(c.supabaseUrl + '/rest/v1/orgs?select=*', {headers: h});
    const d = await fetch(c.supabaseUrl + '/rest/v1/rpc/team', {method: 'POST', headers: {...h, 'Content-Type': 'application/json'}, body: JSON.stringify({p_org: '00000000-0000-0000-0000-000000000000'})});
    return [a.status, b.status, d.status];
  });
  ok(anon.every(s => s === 401 || s === 403), 'customers cannot read records, businesses or teams (' + anon.join(',') + ')');

  /* ---- 5. The owner sees both on Today without copying anything ---- */
  await own.goto(O + '/staff#today');
  await own.waitForSelector('text=From your booking page', {timeout: 15000});
  await own.waitForFunction(() => document.querySelectorAll('[data-act="inbox-open"]').length >= 2, null, {timeout: 15000}).catch(() => {});
  const inbox = await own.locator('[data-act="inbox-open"]').count();
  ok(inbox === 2, 'both arrive in the Today inbox (' + inbox + ')');
  await shot(own, '09-today-inbox');
  const bookingRow = own.locator('.row:has-text("Booking request from Sam Customer")');
  await bookingRow.locator('[data-act="inbox-open"]').click();
  await own.waitForSelector('.sheet input, .sheet select');
  await own.waitForTimeout(400);
  await shot(own, '10-request-opened-as-booking');
  const sheetText = await own.locator('.sheet').first().textContent();
  ok(/Sam Customer|booking page/i.test(sheetText), 'Open turns the request into a pre-filled booking');
  await own.keyboard.press('Escape');

  /* ---- 6. Photos are stored privately for the business ---- */
  const up = await own.evaluate(async () => {
    const cl = await window.PLATFORM.ready; const a = cl.use('assets');
    const blob = await (await fetch('/icons/icon-192.png')).blob();
    const r = await a.upload(blob, {type: 'image/png'});
    const got = await fetch(r.url);
    const usage = await a.list();
    return {id: r.id, status: got.status, type: got.headers.get('content-type'), files: usage.usage.files};
  });
  ok(up.status === 200 && /png/.test(up.type) && up.files === 1, 'photo uploads and comes back through a private signed link');

  /* ---- 6b. A real photo of the car replaces the drawing on the booking page ---- */
  await own.goto(O + '/staff#fleet');
  await own.locator('#view [data-act="car"]').first().click();
  await own.click('[data-act="car-edit"]');
  await own.waitForSelector('#cr-photo');
  await own.setInputFiles('#cr-pic', new URL('./fixtures/car.jpg', import.meta.url).pathname);
  await own.waitForSelector('#cr-photo .cpic img');
  await shot(own, '10b-car-photo');
  await own.click('.sheet button[type=submit][form="cf2"]');
  await own.waitForSelector('text=Car saved');
  await own.keyboard.press('Escape');
  let pubPhoto = '';
  for (let i = 0; i < 30 && !pubPhoto; i++) { await own.waitForTimeout(500); const r = (await H.pool.query(`select data from public.records where col = 'public' and id = 'availability'`)).rows[0]; pubPhoto = (r.data.cars.find(c => c.photo) || {}).photo || ''; }
  ok(/\/storage\/v1\/object\/public\/car-photos\//.test(pubPhoto), 'car photo is published to the booking page');
  const stored = H.files.get('car-photos/' + pubPhoto.split('/car-photos/')[1]);
  ok(stored.type === 'image/jpeg' && !stored.bytes.includes(Buffer.from('Exif')) && !stored.bytes.includes(Buffer.from('GPS')), 'photo is re-saved as a compressed JPEG with the phone\u2019s location data stripped');
  await cus.goto(O + '/test-hire');
  await cus.waitForSelector('#grid img.carph');
  await cus.locator('#grid img.carph').first().scrollIntoViewIfNeeded();
  await cus.waitForFunction(() => { const i = document.querySelector('#grid img.carph'); return i && i.complete && i.naturalWidth > 0; }, null, {timeout: 10000});
  const drawings = await cus.locator('#grid .pic svg').count();
  ok(drawings > 0, 'customers see the real photo, and cars without one keep their drawing (' + drawings + ')');
  await cus.waitForTimeout(300);
  await shot(cus, '05b-booking-page-photo');

  /* ---- 7. A member of staff joins ---- */
  await own.click('#pf-acct');
  await own.waitForSelector('#pf-team .pf-row');
  await own.fill('#pf-inv [name=email]', 'Bob@Test.dev');
  await own.click('#pf-inv button[type=submit]');
  await own.waitForSelector('#pf-team .pf-row:has-text("bob@test.dev")');
  await shot(own, '11-team-panel');
  ok(true, 'owner adds staff by email');
  await own.click('#pf-sheet [data-x]');

  const bob = await newPage('staff', {mobile: true});
  await bob.goto(O + '/staff');
  await bob.click('#pf-go-up');
  await bob.fill('#pf-su [name=name]', 'Bob Staff');
  await bob.fill('#pf-su [name=email]', 'bob@test.dev');
  await bob.fill('#pf-su [name=password]', 'another-pass-2');
  await bob.click('#pf-su button[type=submit]');
  await bob.waitForSelector('#pf-gate', {state: 'detached'});
  await bob.waitForSelector('text=From your booking page');
  ok((await bob.textContent('#bizname')) === 'Test Hire', 'staff land straight in the business tracker');
  await shot(bob, '12-staff-phone-today');
  // staff clears the details form; the owner's screen catches up
  await bob.locator('.row:has-text("Hire details from Sam Customer") [data-act="inbox-done"]').click();
  await own.evaluate(() => { location.hash = 'today'; });
  await own.waitForFunction(() => document.querySelectorAll('[data-act="inbox-open"]').length === 1, null, {timeout: 15000});
  ok(true, 'a change on one phone shows on the other within seconds');
  const bobUrl = await bob.evaluate(async id => { await new Promise(r => setTimeout(r, 50)); window.PLATFORM.assetUrl(id); await new Promise(r => setTimeout(r, 600)); return window.PLATFORM.assetUrl(id); }, up.id);
  ok(/token=/.test(bobUrl), 'team members can see the business’s photos');

  /* ---- 8. Someone not on the team gets nothing ---- */
  const eve = await newPage('outsider');
  await eve.goto(O + '/staff');
  await eve.click('#pf-go-up');
  await eve.fill('#pf-su [name=name]', 'Eve'); await eve.fill('#pf-su [name=email]', 'eve@test.dev'); await eve.fill('#pf-su [name=password]', 'eve-password-3');
  await eve.click('#pf-su button[type=submit]');
  await eve.waitForSelector('#pf-gate h1:has-text("signed in")');
  const evePeek = await eve.evaluate(async id => {
    const c = window.APP_CONFIG; const s = JSON.parse(localStorage.getItem('hire-auth'));
    const h = {apikey: c.supabaseKey, Authorization: 'Bearer ' + s.access_token};
    const r = await (await fetch(c.supabaseUrl + '/rest/v1/records?select=*', {headers: h})).json();
    const sign = await (await fetch(c.supabaseUrl + '/storage/v1/object/sign/assets', {method: 'POST', headers: {...h, 'Content-Type': 'application/json'}, body: JSON.stringify({expiresIn: 60, paths: ['x/' + id]})})).json();
    return {rows: r.length, signed: sign.filter(x => x.signedURL).length};
  }, up.id);
  ok(evePeek.rows === 0 && evePeek.signed === 0, 'a signed-in outsider sees no records and no photos');
  await shot(eve, '13-not-on-a-team');

  /* ---- 9. Forgotten password ---- */
  const fp = await newPage('reset');
  await fp.goto(O + '/staff');
  await fp.click('#pf-go-forgot');
  await fp.fill('#pf-fp [name=email]', 'owner@test.dev');
  await fp.click('#pf-fp button[type=submit]');
  await fp.waitForSelector('.pf-ok');
  const link = await (await fetch(O + '/__test/link?email=owner@test.dev')).json();
  await fp.goto(link.url);
  await fp.waitForSelector('#pf-np');
  ok(!(await fp.evaluate(() => location.hash)).includes('access_token'), 'tokens are cleared from the address bar');
  await fp.fill('#pf-np [name=password]', 'brand-new-pass-9');
  await fp.fill('#pf-np [name=again]', 'brand-new-pass-9');
  await fp.click('#pf-np button[type=submit]');
  await fp.waitForSelector('#pf-gate', {state: 'detached'});
  ok(true, 'reset link lets you choose a new password and go straight in');

  /* ---- 10. Sign out, sign back in with the new password ---- */
  await fp.click('#pf-acct');
  await fp.click('#pf-sheet [data-out]');
  await fp.waitForSelector('#pf-si');
  await fp.fill('#pf-si [name=email]', 'owner@test.dev');
  await fp.fill('#pf-si [name=password]', 'correct-horse-1');
  await fp.click('#pf-si button[type=submit]');
  await fp.waitForSelector('#pf-err:not([hidden])');
  ok((await fp.textContent('#pf-err')).includes('don’t match'), 'old password no longer works');
  await fp.fill('#pf-si [name=password]', 'brand-new-pass-9');
  await fp.click('#pf-si button[type=submit]');
  await fp.waitForSelector('#pf-gate', {state: 'detached'});
  ok(true, 'signs back in with the new password');
  await fp.click('#pf-acct');
  await fp.click('#pf-sheet [data-pw]');
  await fp.fill('#pf-cpw [name=password]', 'changed-in-app-7');
  await fp.fill('#pf-cpw [name=again]', 'changed-in-app-7');
  await fp.click('#pf-cpw button[type=submit]');
  await fp.waitForSelector('#pf-cpw .pf-ok');
  await fp.click('#pf-sheet [data-out]');
  await fp.waitForSelector('#pf-si');
  await fp.fill('#pf-si [name=email]', 'owner@test.dev');
  await fp.fill('#pf-si [name=password]', 'changed-in-app-7');
  await fp.click('#pf-si button[type=submit]');
  await fp.waitForSelector('#pf-gate', {state: 'detached'});
  ok(true, 'password can be changed from the account panel without email');

  /* ---- 11. Unknown booking page ---- */
  await cus.goto(O + '/nobody-here');
  await cus.waitForSelector('#rtitle:has-text("couldn")');
  ok(true, 'unknown page address shows a clear message');
  await cus.goto(O + '/staff-only-typo/details');
  ok(true, 'details form for unknown address still loads');

  ok(H.unhandled.length === 0, 'every API call the app made is covered by the test rig' + (H.unhandled.length ? ': ' + H.unhandled.join(' | ') : ''));
  // The 401s and 400 come from this test's own break-in attempts and wrong-password check.
  const real = errors.filter(e => !/^customer: Failed to load resource: .* 401/.test(e) && !/^reset: Failed to load resource: .* 400/.test(e));
  ok(real.length === 0, 'no unexpected errors in the browser console' + (real.length ? ':\n  ' + real.join('\n  ') : ''));
} finally {
  await B.close();
  await H.close();
}
console.log(`\nEnd-to-end checks passed: ${checks}`);
