// TEST ONLY. Serves the site the way Vercel does (same rewrites, same security headers)
// and stands in for the parts of Supabase the app uses: auth, the REST API and storage,
// all running against a real local Postgres with the real schema and security rules.
// Realtime isn't mocked, so the app's polling fallback is what gets tested.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SITE = path.join(ROOT, 'site');
const SECRET = 'test-secret';
const KEY = 'sb_publishable_testkey';

export async function startHarness({port = 8090, db = 'hiree2e', confirmEmail = false, pollMs = 1500, signupCode = 'open-sesame'} = {}) {
  const base = {host: '/tmp/pg', port: 54322, user: 'postgres'};
  const admin = new pg.Client({...base, database: 'postgres'});
  await admin.connect();
  await admin.query(`drop database if exists ${db} with (force)`);
  await admin.query(`create database ${db}`);
  await admin.end();
  const pool = new pg.Pool({...base, database: db, max: 8});
  await pool.query(fs.readFileSync(path.join(ROOT, 'tests/supabase_stub.sql'), 'utf8'));
  await pool.query(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
  await pool.query(`update public.app_config set value = $1 where key = 'signup_code'`, [signupCode]);

  const passwords = new Map();       // user id -> password
  const refresh = new Map();         // refresh token -> user id
  const files = new Map();           // storage path -> {type, bytes}
  const links = new Map();           // email -> last link sent {type, redirect}
  const unhandled = [];
  const origin = `http://localhost:${port}`;

  /* ---------- tiny JWT ---------- */
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = claims => { const h = b64({alg: 'HS256', typ: 'JWT'}), p = b64(claims); return h + '.' + p + '.' + crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url'); };
  const verify = t => {
    const [h, p, s] = String(t || '').split('.');
    if (!s || crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url') !== s) return null;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    return c.exp * 1000 > Date.now() ? c : null;
  };
  async function userRow(id) { return (await pool.query('select * from auth.users where id = $1', [id])).rows[0]; }
  const userJson = u => ({id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.email_confirmed_at, confirmed_at: u.email_confirmed_at,
    user_metadata: u.raw_user_meta_data || {}, app_metadata: {provider: 'email', providers: ['email']}, identities: [], created_at: u.created_at, updated_at: u.created_at});
  function session(u) {
    const now = Math.floor(Date.now() / 1000), exp = now + 3600;
    const rt = crypto.randomBytes(16).toString('hex'); refresh.set(rt, u.id);
    const at = sign({sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', iat: now, exp, session_id: crypto.randomUUID(), aal: 'aal1', is_anonymous: false,
      user_metadata: u.raw_user_meta_data || {}, app_metadata: {provider: 'email'}});
    return {access_token: at, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: rt, user: userJson(u)};
  }
  function linkFor(u, type, redirect) { const s = session(u); return (redirect || origin + '/staff') + '#access_token=' + s.access_token + '&expires_at=' + s.expires_at + '&expires_in=3600&refresh_token=' + s.refresh_token + '&token_type=bearer&type=' + type; }

  /* ---------- helpers ---------- */
  const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, {'Content-Type': isBuf ? (headers['Content-Type'] || 'application/octet-stream') : 'application/json', ...headers});
    res.end(isBuf ? body : body === undefined ? '' : JSON.stringify(body));
  };
  const IDENT = /^[a-z_][a-z0-9_]*$/;
  function claimsOf(req) {
    const a = req.headers.authorization || '';
    const c = a.startsWith('Bearer ') ? verify(a.slice(7)) : null;
    return c || {role: 'anon'};
  }
  async function asRole(claims, fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${claims.role === 'authenticated' ? 'authenticated' : 'anon'}`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  function pgErr(res, e, claims) {
    const status = e.code === '42501' ? (claims.role === 'anon' ? 401 : 403) : e.code === '23505' ? 409 : 400;
    send(res, status, {code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null});
  }

  /* ---------- auth ---------- */
  async function auth(req, res, url) {
    const p = url.pathname.replace('/auth/v1', '');
    const body = req.method === 'GET' ? {} : JSON.parse((await readBody(req)).toString() || '{}');
    if (p === '/signup' && req.method === 'POST') {
      const email = String(body.email || '').toLowerCase();
      const exists = (await pool.query('select * from auth.users where email = $1', [email])).rows[0];
      if (exists) return send(res, 422, {code: 'user_already_exists', error_code: 'user_already_exists', msg: 'User already registered'});
      const u = (await pool.query('insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3) returning *', [email, confirmEmail ? null : new Date(), body.data || {}])).rows[0];
      passwords.set(u.id, body.password);
      if (confirmEmail) { links.set(email, {type: 'signup', redirect: url.searchParams.get('redirect_to')}); return send(res, 200, userJson(u)); }
      return send(res, 200, session(u));
    }
    if (p === '/token' && url.searchParams.get('grant_type') === 'password') {
      const u = (await pool.query('select * from auth.users where email = $1', [String(body.email || '').toLowerCase()])).rows[0];
      if (!u || passwords.get(u.id) !== body.password) return send(res, 400, {code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials'});
      if (!u.email_confirmed_at) return send(res, 400, {code: 'email_not_confirmed', error_code: 'email_not_confirmed', msg: 'Email not confirmed'});
      return send(res, 200, session(u));
    }
    if (p === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const id = refresh.get(body.refresh_token); if (!id) return send(res, 400, {code: 'refresh_token_not_found', msg: 'Invalid Refresh Token'});
      return send(res, 200, session(await userRow(id)));
    }
    if (p === '/user') {
      const c = claimsOf(req); if (!c.sub) return send(res, 401, {code: 'no_authorization', msg: 'not signed in'});
      if (req.method === 'PUT') {
        if (body.password) { if (passwords.get(c.sub) === body.password) return send(res, 422, {code: 'same_password', msg: 'New password should be different from the old password.'}); passwords.set(c.sub, body.password); }
        if (body.data) await pool.query('update auth.users set raw_user_meta_data = raw_user_meta_data || $2 where id = $1', [c.sub, body.data]);
      }
      return send(res, 200, userJson(await userRow(c.sub)));
    }
    if (p === '/logout') return send(res, 204);
    if (p === '/recover') { links.set(String(body.email || '').toLowerCase(), {type: 'recovery', redirect: url.searchParams.get('redirect_to')}); return send(res, 200, {}); }
    if (p === '/resend') { return send(res, 200, {}); }
    unhandled.push(req.method + ' ' + url.pathname + url.search); return send(res, 404, {msg: 'not in mock'});
  }

  /* ---------- REST ---------- */
  function parseFilters(url) {
    const where = [], vals = [];
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'offset', 'limit', 'on_conflict', 'columns'].includes(k)) continue;
      if (!IDENT.test(k)) throw new Error('bad column ' + k);
      let m;
      if ((m = /^(not\.)?in\.\((.*)\)$/.exec(v))) { vals.push(m[2].split(',').map(s => s.replace(/^"|"$/g, ''))); where.push(`${m[1] ? 'not ' : ''}${k} = any($${vals.length})`); }
      else if ((m = /^(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(v))) { vals.push(m[2]); where.push(`${k} ${{eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<='}[m[1]]} $${vals.length}`); }
      else if ((m = /^is\.(null|true|false)$/.exec(v))) where.push(`${k} is ${m[1]}`);
      else throw new Error('filter not in mock: ' + k + '=' + v);
    }
    return {where, vals};
  }
  async function rest(req, res, url) {
    const claims = claimsOf(req);
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    try {
      if (rpc) {
        const args = JSON.parse((await readBody(req)).toString() || '{}');
        const fn = rpc[1];
        const info = (await pool.query(`select proretset, prorettype::regtype::text as t from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn])).rows[0];
        if (!info) return send(res, 404, {code: 'PGRST202', message: 'function not found'});
        const names = Object.keys(args); names.forEach(n => { if (!IDENT.test(n)) throw new Error('bad arg'); });
        const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
        const out = await asRole(claims, c => c.query(info.proretset ? `select * from ${call}` : `select ${call} as r`, names.map(n => args[n])));
        return send(res, 200, info.proretset ? out.rows : out.rows[0].r);
      }
      const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)[1];
      if (req.method === 'GET') {
        const sel = (url.searchParams.get('select') || '*').split(',').map(s => s.trim());
        sel.forEach(s => { if (s !== '*' && !IDENT.test(s)) throw new Error('bad select'); });
        const {where, vals} = parseFilters(url);
        const order = (url.searchParams.get('order') || '').split(',').filter(Boolean).map(o => { const [c, d] = o.split('.'); if (!IDENT.test(c)) throw new Error('bad order'); return c + (d === 'desc' ? ' desc' : ' asc'); });
        const lim = url.searchParams.get('limit'), off = url.searchParams.get('offset');
        const q = `select ${sel.join(',')} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}${order.length ? ' order by ' + order.join(',') : ''}${lim ? ' limit ' + (+lim) : ''}${off ? ' offset ' + (+off) : ''}`;
        const out = await asRole(claims, c => c.query(q, vals));
        const one = /vnd\.pgrst\.object/.test(req.headers.accept || '');
        return send(res, 200, one ? out.rows[0] || null : out.rows);
      }
      if (req.method === 'POST') {
        let rows = JSON.parse((await readBody(req)).toString()); if (!Array.isArray(rows)) rows = [rows];
        const cols = Object.keys(rows[0]); cols.forEach(cn => { if (!IDENT.test(cn)) throw new Error('bad col'); });
        const vals = [], tuples = rows.map(r => '(' + cols.map(cn => { vals.push(typeof r[cn] === 'object' && r[cn] !== null ? JSON.stringify(r[cn]) : r[cn]); return '$' + vals.length; }).join(',') + ')');
        const conflict = url.searchParams.get('on_conflict');
        const merge = /merge-duplicates/.test(req.headers.prefer || '');
        let q = `insert into public.${table} (${cols.join(',')}) values ${tuples.join(',')}`;
        if (conflict) q += ` on conflict (${conflict.split(',').filter(x => IDENT.test(x)).join(',')}) ` + (merge ? 'do update set ' + cols.map(cn => `${cn} = excluded.${cn}`).join(', ') : 'do nothing');
        const rep = /return=representation/.test(req.headers.prefer || '');
        const sel = url.searchParams.get('select');
        if (rep) q += ' returning ' + (sel ? sel.split(',').filter(x => IDENT.test(x)).join(',') : '*');
        const out = await asRole(claims, c => c.query(q, vals));
        return send(res, 201, rep ? out.rows : undefined);
      }
      unhandled.push(req.method + ' ' + url.pathname); return send(res, 405, {message: 'not in mock'});
    } catch (e) {
      if (e.code) return pgErr(res, e, claims);
      unhandled.push(req.method + ' ' + url.pathname + url.search + ' :: ' + e.message);
      return send(res, 400, {message: e.message});
    }
  }

  /* ---------- storage ---------- */
  function multipartFile(buf, ctype) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype || ''); if (!m) return {type: ctype, bytes: buf};
    const b = Buffer.from('--' + (m[1] || m[2]));
    let i = buf.indexOf(b), out = null;
    while (i >= 0) {
      const next = buf.indexOf(b, i + b.length); if (next < 0) break;
      const part = buf.subarray(i + b.length + 2, next - 2);
      const sep = part.indexOf('\r\n\r\n'); const head = part.subarray(0, sep).toString();
      if (/filename=|name=""/.test(head)) { const t = /content-type:\s*([^\r\n]+)/i.exec(head); out = {type: t ? t[1] : 'application/octet-stream', bytes: part.subarray(sep + 4)}; }
      i = next;
    }
    return out || {type: ctype, bytes: buf};
  }
  const signTok = p => crypto.createHmac('sha256', SECRET).update('file:' + p).digest('base64url');
  async function storage(req, res, url) {
    const claims = claimsOf(req);
    const p = decodeURIComponent(url.pathname.replace('/storage/v1', ''));
    const sErr = (e) => send(res, 400, {statusCode: e.code === '42501' ? '403' : '400', error: 'Unauthorized', message: e.code === '42501' ? 'new row violates row-level security policy' : e.message});
    try {
      let m;
      if (req.method === 'GET' && (m = /^\/object\/sign\/assets\/(.+)$/.exec(p))) {
        if (url.searchParams.get('token') !== signTok(m[1]) || !files.has('assets/' + m[1])) return send(res, 400, {statusCode: '404', error: 'not_found', message: 'Object not found'});
        const f = files.get('assets/' + m[1]); return send(res, 200, f.bytes, {'Content-Type': f.type});
      }
      if (req.method === 'GET' && (m = /^\/object\/public\/([a-z-]+)\/(.+)$/.exec(p))) {
        const pub = (await pool.query('select public from storage.buckets where id = $1', [m[1]])).rows[0];
        if (!pub || !pub.public || !files.has(m[1] + '/' + m[2])) return send(res, 400, {statusCode: '404', error: 'not_found', message: 'Object not found'});
        const f = files.get(m[1] + '/' + m[2]); return send(res, 200, f.bytes, {'Content-Type': f.type});
      }
      if (req.method === 'POST' && p === '/object/sign/assets') {
        const body = JSON.parse((await readBody(req)).toString());
        const ok = await asRole(claims, c => c.query(`select name from storage.objects where bucket_id = 'assets' and name = any($1)`, [body.paths]));
        const have = new Set(ok.rows.map(r => r.name));
        return send(res, 200, body.paths.map(x => have.has(x) ? {error: null, path: x, signedURL: '/object/sign/assets/' + x + '?token=' + signTok(x)} : {error: 'Either the object does not exist or you do not have access to it', path: x, signedURL: null}));
      }
      if (req.method === 'POST' && (m = /^\/object\/sign\/assets\/(.+)$/.exec(p))) {
        const ok = await asRole(claims, c => c.query(`select name from storage.objects where bucket_id = 'assets' and name = $1`, [m[1]]));
        if (!ok.rowCount) return send(res, 400, {statusCode: '404', error: 'not_found', message: 'Object not found'});
        return send(res, 200, {signedURL: '/object/sign/assets/' + m[1] + '?token=' + signTok(m[1])});
      }
      if (req.method === 'POST' && (m = /^\/object\/list\/assets$/.exec(p))) {
        const body = JSON.parse((await readBody(req)).toString());
        const out = await asRole(claims, c => c.query(`select id, name, created_at from storage.objects where bucket_id = 'assets' and name like $1 order by name limit $2 offset $3`, [body.prefix + '/%', body.limit || 100, body.offset || 0]));
        return send(res, 200, out.rows.map(r => ({name: r.name.split('/').pop(), id: r.id, created_at: r.created_at, metadata: {size: (files.get('assets/' + r.name) || {bytes: []}).bytes.length}})));
      }
      if ((req.method === 'POST' || req.method === 'PUT') && (m = /^\/object\/(assets|car-photos)\/(.+)$/.exec(p))) {
        const f = multipartFile(await readBody(req), req.headers['content-type']);
        const lim = (await pool.query('select file_size_limit, allowed_mime_types from storage.buckets where id = $1', [m[1]])).rows[0];
        if (f.bytes.length > +lim.file_size_limit) return send(res, 400, {statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size'});
        if (lim.allowed_mime_types && !lim.allowed_mime_types.includes(f.type)) return send(res, 400, {statusCode: '415', error: 'invalid_mime_type', message: 'mime type ' + f.type + ' is not supported'});
        const r = await asRole(claims, c => c.query(`insert into storage.objects (bucket_id, name, owner, metadata) values ($1, $2, $3, $4) returning id`, [m[1], m[2], claims.sub || null, {mimetype: f.type, size: f.bytes.length}]));
        files.set(m[1] + '/' + m[2], f);
        return send(res, 200, {Key: m[1] + '/' + m[2], Id: r.rows[0].id});
      }
      if (req.method === 'DELETE' && (m = /^\/object\/(assets|car-photos)$/.exec(p))) {
        const body = JSON.parse((await readBody(req)).toString());
        const out = await asRole(claims, c => c.query(`delete from storage.objects where bucket_id = $1 and name = any($2) returning name`, [m[1], body.prefixes]));
        out.rows.forEach(r => files.delete(m[1] + '/' + r.name));
        return send(res, 200, out.rows.map(r => ({name: r.name, bucket_id: m[1]})));
      }
      unhandled.push(req.method + ' ' + url.pathname); return send(res, 404, {message: 'not in mock'});
    } catch (e) { return e.code ? sErr(e) : send(res, 400, {message: e.message}); }
  }

  /* ---------- the site, like Vercel serves it ---------- */
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const csp = vercel.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value.replace(/https:\/\/\*\.supabase\.co|wss:\/\/\*\.supabase\.co/g, '');
  const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain'};
  const rewrites = vercel.rewrites.map(r => ({re: new RegExp('^' + r.source.replace(/:slug\((.*?)\)(?=\/|$)/g, '($1)') + '$'), dest: r.destination}));
  function staticFile(req, res, url) {
    if (url.pathname === '/config.js') {
      return send(res, 200, Buffer.from(`window.APP_CONFIG = ${JSON.stringify({supabaseUrl: origin, supabaseKey: KEY, platformName: 'Hire Desk', pollMs})};`), {'Content-Type': TYPES['.js']});
    }
    let p = url.pathname.replace(/\/+$/, '') || '/';
    const tryFile = f => { try { return fs.statSync(f).isFile() ? f : null; } catch (e) { return null; } };
    let file = tryFile(path.join(SITE, p)) || tryFile(path.join(SITE, p + '.html')) || tryFile(path.join(SITE, p, 'index.html'));
    if (!file) { const rw = rewrites.find(r => r.re.test(p)); if (rw) file = path.join(SITE, rw.dest); }
    if (!file || !file.startsWith(SITE)) { res.writeHead(404, {'Content-Type': TYPES['.html'], 'Content-Security-Policy': csp}); return res.end(fs.readFileSync(path.join(SITE, '404.html'))); }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'});
    res.end(fs.readFileSync(file));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*'}); return res.end(); }
    try {
      if (url.pathname.startsWith('/__test/link')) { const l = links.get(url.searchParams.get('email')); const u = (await pool.query('select * from auth.users where email = $1', [url.searchParams.get('email')])).rows[0];
        if (!l || !u) return send(res, 404, {});
        if (l.type === 'signup') await pool.query('update auth.users set email_confirmed_at = now() where id = $1', [u.id]);
        return send(res, 200, {url: linkFor(u, l.type, l.redirect)}); }
      if (url.pathname.startsWith('/auth/v1')) return await auth(req, res, url);
      if (url.pathname.startsWith('/rest/v1')) return await rest(req, res, url);
      if (url.pathname.startsWith('/storage/v1')) return await storage(req, res, url);
      if (url.pathname.startsWith('/realtime')) { res.writeHead(404); return res.end(); }
      return staticFile(req, res, url);
    } catch (e) { console.error('harness error', e); send(res, 500, {message: e.message}); }
  });
  server.on('upgrade', (req, socket) => socket.destroy());
  await new Promise(r => server.listen(port, r));
  return {origin, pool, unhandled, links, files, close: async () => { await new Promise(r => server.close(r)); await pool.end(); }};
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const h = await startHarness({port: +(process.env.PORT || 8090), confirmEmail: !!process.env.CONFIRM});
  console.log('Harness running at', h.origin);
}
