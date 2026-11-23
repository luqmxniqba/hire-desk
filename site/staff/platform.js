/* =====================================================================
   Platform layer for the staff tracker.
   Signs people in, picks their business, and gives the tracker the same
   storage, photos and downloads it had inside Claude, backed by Supabase.
   The tracker waits for PLATFORM.ready before it starts.
   ===================================================================== */
(function () {
'use strict';

var CFG = window.APP_CONFIG || {};
var NAME = CFG.platformName || 'Hire Desk';
var DEMO = new URLSearchParams(location.search).has('demo');
var LAST_ORG = 'hire-last-org';
var LAZY = ['signatures', 'public'];          // loaded only when asked for, not kept in memory
var POLL_MS = CFG.pollMs || 30000;
var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* Auth links come back with tokens in the URL hash. The tracker uses the hash for
   its pages, so take them out before it looks. */
var authHash = null;
if (/(^|[#&])(access_token|error_description|error_code)=/.test(location.hash)) {
  authHash = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
}
// A sign-in link opened in a tab that already has the app open: start again so it's picked up.
window.addEventListener('hashchange', function () {
  if (/(^|[#&])(access_token|error_description|error_code)=/.test(location.hash)) location.reload();
});

var resolveReady;
var P = window.PLATFORM = {
  ready: new Promise(function (r) { resolveReady = r; }),
  demo: DEMO,
  bookingUrl: function () { return ''; },
  formUrl: function () { return ''; },
  attach: attach,
  assetUrl: assetUrl,
  fixSettings: fixSettings
};
var T = {bump: function () {}, toast: function () {}};
function attach(hooks) { T = Object.assign(T, hooks || {}); }

var $ = function (s, el) { return (el || document).querySelector(s); };
var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); };
var clone = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); };
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// Demo: the tracker runs on example data saved in this browser. Downloads still work.
if (DEMO) { resolveReady({use: function (n) { return n === 'downloads' ? {save: saveDownload} : null; }}); return; }

var connected = CFG.supabaseUrl && !/YOUR-PROJECT/.test(CFG.supabaseUrl) && CFG.supabaseKey && !/YOUR-/.test(CFG.supabaseKey) && window.supabase;
var sb = connected ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'implicit', storageKey: 'hire-auth'}
}) : null;

var USER = null, BIZ = [], ORG = null, RECOVERY = false, NOTICE = '', NOTICE_OK = '';

/* ---------------------------------------------------------------------
   Sign-in screens
   --------------------------------------------------------------------- */
var STYLE = [
  '.pf-gate{position:fixed;inset:0;z-index:1000;background:#15171a;display:grid;place-items:center;padding:24px 16px;overflow:auto;font:16px/1.5 Barlow,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
  '.pf-card{width:min(100%,430px);background:var(--bg,#fff);color:var(--ink,#141518);border-radius:16px;padding:26px 24px 22px;box-shadow:0 20px 60px rgba(0,0,0,.35)}',
  '.pf-brand{display:flex;align-items:center;gap:10px;font:700 20px/1 "Barlow Condensed",Barlow,sans-serif;letter-spacing:.01em;margin-bottom:18px}',
  '.pf-brand svg{width:30px;height:30px;flex:none}',
  '.pf-card h1{font:700 30px/1.05 "Barlow Condensed",Barlow,sans-serif;margin:0 0 6px;text-wrap:balance}',
  '.pf-sub{color:var(--mute,#585c63);margin:0 0 18px}',
  '.pf-f{display:grid;gap:14px}',
  '.pf-l{display:grid;gap:5px}.pf-l>span{font-size:15px;font-weight:600}.pf-l small{color:var(--mute,#585c63);font-size:13.5px}',
  '.pf-l input,.pf-l select,.pf-in{width:100%;min-height:48px;padding:10px 12px;border-radius:9px;border:1.5px solid var(--line2,#c9cbcf);background:var(--field,#fff);color:inherit;font:inherit;font-size:16px}',
  '.pf-l input:focus,.pf-l select:focus,.pf-in:focus{outline:none;border-color:var(--blue,#0b4fb3);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue,#0b4fb3) 25%,transparent)}',
  '.pf-b{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:50px;padding:0 16px;border-radius:10px;border:1.5px solid var(--line2,#c9cbcf);background:transparent;color:inherit;font:700 17px/1.2 Barlow,sans-serif;cursor:pointer;text-decoration:none}',
  '.pf-b.pri{background:#ffd400;border-color:#ffd400;color:#141414}',
  '.pf-b.sm{min-height:38px;width:auto;font-size:15px;padding:0 12px;border-radius:8px}',
  '.pf-b.danger{color:var(--red,#c4221a)}',
  '.pf-b:disabled{opacity:.55;cursor:default}',
  '.pf-b:focus-visible,.pf-link:focus-visible{outline:3px solid var(--blue,#0b4fb3);outline-offset:2px}',
  '.pf-link{background:none;border:0;padding:0;color:var(--blue,#0b4fb3);font:inherit;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
  '.pf-alt{margin:16px 0 0;display:flex;flex-wrap:wrap;gap:8px 18px;justify-content:space-between;font-size:15px}',
  '.pf-err{background:var(--redbg,#fdecea);color:var(--red,#c4221a);border-radius:9px;padding:10px 12px;font-weight:600;font-size:15px;margin:0 0 14px}',
  '.pf-ok{background:color-mix(in srgb,#11713a 12%,transparent);color:var(--green,#11713a);border-radius:9px;padding:10px 12px;font-weight:600;font-size:15px;margin:0 0 14px}',
  '.pf-box{background:var(--panel,#f4f4f1);border:1px solid var(--line,#e0e1e3);border-radius:12px;padding:14px;margin:0 0 14px}',
  '.pf-box p{margin:0}.pf-box p+p{margin-top:8px}',
  '.pf-list{display:grid;gap:8px;margin:0 0 14px}',
  '.pf-list button{text-align:left;justify-content:space-between}',
  '.pf-spin{width:28px;height:28px;border-radius:50%;border:3px solid var(--line,#e0e1e3);border-top-color:#ffd400;animation:pf-r .8s linear infinite;margin:6px auto 12px}',
  '@keyframes pf-r{to{transform:rotate(360deg)}}',
  'details.pf-d summary{cursor:pointer;font-weight:700;color:var(--blue,#0b4fb3);margin:4px 0 12px}',
  '.pf-acct{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;flex:none;border-radius:50%;border:2px solid #ffd400;background:transparent;color:inherit;font:700 15px/1 "Barlow Condensed",Barlow,sans-serif;letter-spacing:.03em;cursor:pointer}',
  '.pf-acct:focus-visible{outline:3px solid var(--blue,#0b4fb3);outline-offset:2px}',
  '.pf-sheet{position:fixed;inset:0;z-index:900;background:rgba(10,11,13,.55);display:flex;justify-content:flex-end}',
  '.pf-panel{width:min(100%,440px);height:100%;overflow:auto;background:var(--bg,#fff);color:var(--ink,#141518);padding:20px 20px 40px;box-shadow:-10px 0 40px rgba(0,0,0,.25)}',
  '.pf-panel h2{font:700 26px/1.1 "Barlow Condensed",Barlow,sans-serif;margin:0}',
  '.pf-panel h3{font:700 19px/1.2 "Barlow Condensed",Barlow,sans-serif;margin:22px 0 10px}',
  '.pf-ph{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}',
  '.pf-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line,#e0e1e3)}',
  '.pf-row .who{min-width:0;overflow-wrap:anywhere}.pf-row .who small{display:block;color:var(--mute,#585c63)}',
  '.pf-inline{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:10px}',
  '.pf-inline select{min-height:48px}',
  '.pf-mute{color:var(--mute,#585c63);font-size:14px}',
  '.pf-code{display:block;font:500 14px/1.4 ui-monospace,Menlo,monospace;background:var(--panel,#f4f4f1);padding:8px 10px;border-radius:8px;overflow-wrap:anywhere;margin:6px 0 10px}',
  '.pf-pill{position:fixed;left:12px;bottom:calc(76px + env(safe-area-inset-bottom));z-index:800;background:#c4221a;color:#fff;border-radius:999px;padding:7px 13px;font:600 14px/1.2 Barlow,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25)}',
  '@media(min-width:900px){.pf-pill{bottom:16px}}'
].join('\n');

var MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 3h14a3 3 0 0 1 3 3v17.5L16 30 6 23.5V6a3 3 0 0 1 3-3z" fill="#ffd400"/><circle cx="16" cy="9" r="2.6" fill="#15171a"/><path d="M10 17h12M10 21h8" stroke="#15171a" stroke-width="2.2" stroke-linecap="round"/></svg>';

function injectStyle() {
  if ($('#pf-style')) return;
  var s = document.createElement('style'); s.id = 'pf-style'; s.textContent = STYLE; document.head.appendChild(s);
}
function gateEl() {
  var g = $('#pf-gate');
  if (!g) {
    g = document.createElement('div'); g.id = 'pf-gate'; g.className = 'pf-gate';
    g.setAttribute('role', 'dialog'); g.setAttribute('aria-modal', 'true'); g.setAttribute('aria-labelledby', 'pf-title');
    document.body.appendChild(g);
  }
  return g;
}
function gate(title, sub, body, alt, holdNotice) {
  injectStyle();
  var g = gateEl();
  var note = holdNotice ? '' : NOTICE ? '<p class="pf-err" role="alert">' + esc(NOTICE) + '</p>' : NOTICE_OK ? '<p class="pf-ok" role="status">' + esc(NOTICE_OK) + '</p>' : '';
  if (!holdNotice) { NOTICE = ''; NOTICE_OK = ''; }
  g.innerHTML = '<div class="pf-card"><div class="pf-brand">' + MARK + '<span>' + esc(NAME) + '</span></div>' +
    '<h1 id="pf-title">' + esc(title) + '</h1>' + (sub ? '<p class="pf-sub">' + sub + '</p>' : '') + note +
    '<div id="pf-err" class="pf-err" role="alert" hidden></div>' + (body || '') + (alt ? '<div class="pf-alt">' + alt + '</div>' : '') + '</div>';
  var f = g.querySelector('input:not([type=hidden]),button');
  if (f && window.matchMedia('(min-width: 641px)').matches) f.focus();
  return g;
}
function hideGate() { var g = $('#pf-gate'); if (g) g.remove(); }
function showErr(msg) { var e = $('#pf-err'); if (e) { e.textContent = msg; e.hidden = !msg; } }
function busy(form, on, label) {
  var b = form && form.querySelector('button[type=submit]');
  if (!b) return;
  if (on) { b.dataset.label = b.textContent; b.textContent = label || 'One moment…'; b.disabled = true; }
  else { b.textContent = b.dataset.label || b.textContent; b.disabled = false; }
}
function field(label, input, help) { return '<label class="pf-l"><span>' + label + '</span>' + input + (help ? '<small>' + help + '</small>' : '') + '</label>'; }
function onSubmit(id, fn) {
  var f = document.getElementById(id); if (!f) return;
  f.addEventListener('submit', function (ev) {
    ev.preventDefault(); showErr('');
    var data = Object.fromEntries(new FormData(f).entries());
    busy(f, true);
    Promise.resolve().then(function () { return fn(data, f); }).catch(function (e) { showErr(authText(e)); }).then(function () { if (document.contains(f)) busy(f, false); });
  });
}
function onClick(sel, fn) { var el = $(sel); if (el) el.addEventListener('click', fn); }

function authText(e) {
  var m = String((e && (e.message || e.msg || e.error_description)) || e || '');
  var code = e && (e.code || e.error_code);
  if (/invalid login credentials/i.test(m) || code === 'invalid_credentials') return 'That email and password don’t match.';
  if (/email not confirmed/i.test(m) || code === 'email_not_confirmed') return 'Confirm your email first: open the link we sent you.';
  if (/already registered|already exists/i.test(m) || code === 'user_already_exists') return 'There’s already an account with that email. Sign in instead.';
  if (/rate limit|too many/i.test(m) || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') return 'Too many tries just now. Wait a few minutes and try again.';
  if (/weak|at least/i.test(m) || code === 'weak_password') return 'Pick a longer password: at least 8 characters, not something common.';
  if (/same.*password|different from the old/i.test(m) || code === 'same_password') return 'That’s your current password. Pick a new one.';
  if (code === 'email_address_not_authorized' || /address not authorized/i.test(m)) return 'This app can’t send emails to that address yet, so nothing was sent. Ask whoever runs ' + NAME + ' to finish its email setup.';
  if (/fetch|network|load failed/i.test(m)) return 'Can’t reach the server. Check your connection and try again.';
  return m || 'Something went wrong. Try again.';
}
var BIZ_ERR = {
  setup_closed: 'New businesses can’t be set up yet. Ask whoever runs ' + NAME + ' for a setup code.',
  bad_code: 'That setup code isn’t right.',
  rate_limited: 'Too many tries. Wait an hour and try again.',
  bad_name: 'Add your business name.',
  bad_slug: 'Use 3 to 40 lower-case letters, numbers or dashes for the page address.',
  slug_taken: 'That page address is taken. Try another.',
  too_many: 'You’ve reached the limit for new businesses.',
  signed_out: 'You’ve been signed out. Sign in again.'
};
function slugify(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, ''); }
function displayName(u) { u = u || USER || {}; return (u.user_metadata && u.user_metadata.name) || u.email || ''; }
function staffUrl() { return location.origin + '/staff'; }

function showSignIn(email) {
  gate('Sign in', 'To your business’s tracker.',
    '<form id="pf-si" class="pf-f" novalidate>' +
      field('Email', '<input name="email" type="email" autocomplete="username" inputmode="email" required value="' + esc(email || '') + '">') +
      field('Password', '<input name="password" type="password" autocomplete="current-password" required>') +
      '<button type="submit" class="pf-b pri">Sign in</button></form>',
    '<button type="button" class="pf-link" id="pf-go-forgot">Forgot your password?</button><button type="button" class="pf-link" id="pf-go-up">Create an account</button>');
  onSubmit('pf-si', function (d) {
    if (!d.email || !d.password) throw new Error('Add your email and password.');
    return sb.auth.signInWithPassword({email: d.email.trim(), password: d.password}).then(function (r) {
      if (r.error) {
        if (r.error.code === 'email_not_confirmed' || /not confirmed/i.test(r.error.message)) return showCheckEmail(d.email.trim(), 'Confirm your email to finish. Open the link we sent you, or send it again below.');
        throw r.error;
      }
      return afterSignIn(r.data.session);
    });
  });
  onClick('#pf-go-forgot', function () { showForgot($('#pf-si [name=email]').value); });
  onClick('#pf-go-up', function () { showSignUp($('#pf-si [name=email]').value); });
}

function showSignUp(email) {
  gate('Create your account', 'Use the email your manager added to the team, or the one you’ll run your business with.',
    '<form id="pf-su" class="pf-f" novalidate>' +
      field('Your name', '<input name="name" autocomplete="name" required>') +
      field('Email', '<input name="email" type="email" autocomplete="username" inputmode="email" required value="' + esc(email || '') + '">') +
      field('Password', '<input name="password" type="password" autocomplete="new-password" minlength="8" required>', 'At least 8 characters.') +
      '<button type="submit" class="pf-b pri">Create account</button></form>',
    '<button type="button" class="pf-link" id="pf-go-in">I already have an account</button>');
  onSubmit('pf-su', function (d) {
    var em = (d.email || '').trim();
    if (!d.name.trim() || !em) throw new Error('Add your name and email.');
    if ((d.password || '').length < 8) throw new Error('Use at least 8 characters for your password.');
    return sb.auth.signUp({email: em, password: d.password, options: {emailRedirectTo: staffUrl(), data: {name: d.name.trim()}}}).then(function (r) {
      if (r.error) throw r.error;
      if (r.data.session) return afterSignIn(r.data.session);
      return showCheckEmail(em);
    });
  });
  onClick('#pf-go-in', function () { showSignIn($('#pf-su [name=email]').value); });
}

function showCheckEmail(email, sub) {
  gate('Check your email', esc(sub || 'We’ve sent a link to ' + email + '. Open it to finish setting up. It can take a minute, and might be in junk.'),
    '<div class="pf-f"><button type="button" class="pf-b" id="pf-resend">Send the link again</button></div>',
    '<button type="button" class="pf-link" id="pf-go-in">Back to sign in</button>');
  onClick('#pf-resend', function (ev) {
    var b = ev.currentTarget; b.disabled = true;
    sb.auth.resend({type: 'signup', email: email, options: {emailRedirectTo: staffUrl()}}).then(function (r) {
      if (r.error) { showErr(authText(r.error)); b.disabled = false; } else { b.textContent = 'Sent. Check your inbox'; }
    });
  });
  onClick('#pf-go-in', function () { showSignIn(email); });
}

function showForgot(email) {
  gate('Reset your password', 'We’ll email you a link to choose a new one.',
    '<form id="pf-fp" class="pf-f" novalidate>' +
      field('Email', '<input name="email" type="email" autocomplete="username" inputmode="email" required value="' + esc(email || '') + '">') +
      '<button type="submit" class="pf-b pri">Send the link</button></form>',
    '<button type="button" class="pf-link" id="pf-go-in">Back to sign in</button>');
  onSubmit('pf-fp', function (d) {
    var em = (d.email || '').trim(); if (!em) throw new Error('Add your email.');
    return sb.auth.resetPasswordForEmail(em, {redirectTo: staffUrl()}).then(function (r) {
      if (r.error) throw r.error;
      NOTICE_OK = 'If there’s an account for ' + em + ', a reset link is on its way.';
      showSignIn(em);
    });
  });
  onClick('#pf-go-in', function () { showSignIn($('#pf-fp [name=email]').value); });
}

function showNewPassword() {
  gate('Choose a new password', 'For ' + esc(USER && USER.email || 'your account') + '.',
    '<form id="pf-np" class="pf-f" novalidate>' +
      field('New password', '<input name="password" type="password" autocomplete="new-password" minlength="8" required>', 'At least 8 characters.') +
      field('Type it again', '<input name="again" type="password" autocomplete="new-password" required>') +
      '<button type="submit" class="pf-b pri">Save password</button></form>');
  onSubmit('pf-np', function (d) {
    if ((d.password || '').length < 8) throw new Error('Use at least 8 characters.');
    if (d.password !== d.again) throw new Error('The two passwords don’t match.');
    return sb.auth.updateUser({password: d.password}).then(function (r) {
      if (r.error) throw r.error;
      RECOVERY = false; NOTICE_OK = 'Password saved.';
      return sb.auth.getSession().then(function (s) { return afterSignIn(s.data.session); });
    });
  });
}

function showLoading(msg) { gate(msg || 'Opening your tracker', '', '<div class="pf-spin" aria-hidden="true"></div>', '', true); }

function showNoBusiness() {
  var em = USER && USER.email || '';
  gate('You’re signed in', 'As ' + esc(em) + '.',
    '<div class="pf-box"><p><b>Joining a team?</b> Ask the owner to add <b>' + esc(em) + '</b> in Team, then press the button below.</p></div>' +
    '<div class="pf-f"><button type="button" class="pf-b pri" id="pf-recheck">I’ve been added, check again</button></div>' +
    '<details class="pf-d" style="margin-top:18px"><summary>Setting up a new business</summary>' +
      '<form id="pf-nb" class="pf-f" novalidate>' +
        field('Business name', '<input name="name" autocomplete="organization" required maxlength="80">') +
        field('Booking page address', '<input name="slug" autocapitalize="off" spellcheck="false" required maxlength="40">', 'Customers book at <b id="pf-slugurl">' + esc(location.host) + '/\u2026</b>. Lower-case letters, numbers and dashes.') +
        field('Setup code', '<input name="code" autocomplete="off" autocapitalize="off" spellcheck="false" required>', 'From whoever runs ' + esc(NAME) + '.') +
        '<button type="submit" class="pf-b pri">Set up the business</button></form></details>',
    '<button type="button" class="pf-link" id="pf-out">Sign out</button>');
  var nm = $('#pf-nb [name=name]'), sl = $('#pf-nb [name=slug]'), touched = false;
  var showUrl = function () { $('#pf-slugurl').textContent = location.host + '/' + (slugify(sl.value) || '\u2026'); };
  nm.addEventListener('input', function () { if (!touched) sl.value = slugify(nm.value); showUrl(); });
  sl.addEventListener('input', function () { touched = true; showUrl(); });
  onClick('#pf-recheck', function () { showLoading('Checking'); loadBusinesses(); });
  onClick('#pf-out', signOut);
  onSubmit('pf-nb', function (d) {
    return sb.rpc('create_business', {p_name: d.name, p_slug: slugify(d.slug), p_code: (d.code || '').trim()}).then(function (r) {
      if (r.error) throw r.error;
      if (!r.data || !r.data.ok) throw new Error(BIZ_ERR[r.data && r.data.error] || 'Couldn’t set that up. Try again.');
      var biz = {id: r.data.id, slug: r.data.slug, name: d.name.trim(), role: 'owner'};
      // Start its settings with the name and the customer form switched on.
      return sb.from('records').upsert({org_id: biz.id, col: 'settings', id: 'main', deleted: false,
        data: {businessName: biz.name, formUrl: location.origin + '/' + biz.slug + '/details'}}, {onConflict: 'org_id,col,id'})
        .then(function () { BIZ = [biz]; openBusiness(biz); });
    });
  });
}

function showPicker() {
  gate('Pick a business', 'You’re on more than one team.',
    '<div class="pf-list">' + BIZ.map(function (b, i) {
      return '<button type="button" class="pf-b" data-i="' + i + '"><span>' + esc(b.name) + '</span><span class="pf-mute">' + (b.role === 'owner' ? 'Owner' : 'Staff') + '</span></button>';
    }).join('') + '</div>',
    '<button type="button" class="pf-link" id="pf-out">Sign out</button>');
  $('#pf-gate .pf-list').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-i]'); if (b) openBusiness(BIZ[+b.dataset.i]);
  });
  onClick('#pf-out', signOut);
}

function showFatal(title, msg) { gate(title, esc(msg)); }

function linkErrorText(code, desc) {
  if (code === 'otp_expired' || /expired|invalid/i.test(desc || '')) return 'That link has expired or was already used. Sign in, or ask for a new link.';
  return desc || 'That link didn’t work. Try again.';
}

/* ---------------------------------------------------------------------
   Start-up
   --------------------------------------------------------------------- */
async function start() {
  if (!connected) {
    showFatal('Not connected yet', 'This copy of the app doesn’t have its database details. Add your Supabase project address and key to config.js (see the README).');
    return;
  }
  sb.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT' && ORG) location.reload();
    if (event === 'PASSWORD_RECOVERY') RECOVERY = true;
  });
  if (authHash) {
    var err = authHash.get('error_description') || authHash.get('error_code');
    if (err) NOTICE = linkErrorText(authHash.get('error_code'), authHash.get('error_description'));
    var at = authHash.get('access_token'), rt = authHash.get('refresh_token'), type = authHash.get('type');
    if (at && rt) {
      var r = await sb.auth.setSession({access_token: at, refresh_token: rt});
      if (r.error) NOTICE = 'That link didn’t work. Sign in instead.';
      else if (type === 'recovery') RECOVERY = true;
      else if (type === 'signup' || type === 'email_change' || type === 'invite') NOTICE_OK = 'Email confirmed. Welcome in.';
    }
  }
  var s = await sb.auth.getSession();
  if (!s.data.session) { showSignIn(); return; }
  await afterSignIn(s.data.session);
}

async function afterSignIn(session) {
  USER = session.user;
  if (RECOVERY) { showNewPassword(); return; }
  showLoading();
  await loadBusinesses();
}

async function loadBusinesses() {
  try { await sb.rpc('claim_invites'); } catch (e) { /* not fatal */ }
  var r = await sb.rpc('my_businesses');
  if (r.error) {
    if (r.error.status === 401 || /JWT/i.test(r.error.message || '')) { await sb.auth.signOut(); NOTICE = 'Please sign in again.'; showSignIn(); return; }
    gate('Can’t open the tracker', esc(authText(r.error)), '<div class="pf-f"><button type="button" class="pf-b pri" id="pf-retry">Try again</button></div>');
    onClick('#pf-retry', function () { showLoading(); loadBusinesses(); });
    return;
  }
  BIZ = r.data || [];
  if (!BIZ.length) { showNoBusiness(); return; }
  var last = localStorage.getItem(LAST_ORG);
  var pick = BIZ.find(function (b) { return b.id === last; }) || (BIZ.length === 1 ? BIZ[0] : null);
  if (!pick) { showPicker(); return; }
  openBusiness(pick);
}

function openBusiness(b) {
  ORG = b;
  try { localStorage.setItem(LAST_ORG, b.id); } catch (e) { /* private mode */ }
  P.org = b;
  P.bookingUrl = function () { return location.origin + '/' + b.slug; };
  P.formUrl = function () { return location.origin + '/' + b.slug + '/details'; };
  hideGate();
  mountAccount();
  resolveReady(makeClaude(b));
}

async function signOut() {
  try { await sb.auth.signOut(); } catch (e) { /* still go */ }
  try { localStorage.removeItem(LAST_ORG); } catch (e) { /* ignore */ }
  location.reload();
}

/* ---------------------------------------------------------------------
   What the tracker asks for: db, user, downloads, assets
   --------------------------------------------------------------------- */
function makeClaude(org) {
  var db = makeDb(org.id);
  var user = {
    can: function (perm) { return Promise.resolve(perm === 'data.write' ? (org.role === 'owner' || org.role === 'staff') : true); },
    id: function () { return Promise.resolve(displayName()); }
  };
  var downloads = {save: saveDownload};
  var assets = makeAssets(org.id);
  return {use: function (name) {
    return ({db: db, user: user, downloads: downloads, assets: assets})[name] || null;
  }};
}

function mapErr(e) {
  if (!e) return {code: 'unknown'};
  var msg = String(e.message || e);
  if (e.code === '42501' || e.status === 403 || /row-level security|permission denied/i.test(msg)) return {code: 'not_granted', message: msg};
  if (e.status === 401 || /JWT/i.test(msg)) return {code: 'unauthenticated', message: msg};
  if (e.code === '23514' || e.status === 413) return {code: 'quota_exceeded', message: msg};
  return {code: 'unavailable', message: msg};
}

function makeDb(orgId) {
  var cache = new Map();      // col -> Map(id -> data)
  var pending = new Map();    // "col/id" -> writes in flight
  var colSubs = new Map(), docSubs = new Map();
  var loaded = false, cursor = null, syncing = null, again = false, fails = 0;
  var seenInbox = new Set();

  function colMap(col) { var m = cache.get(col); if (!m) { m = new Map(); cache.set(col, m); } return m; }
  function docSnap(id, v) { return {id: id, exists: v !== undefined, data: function () { return v === undefined ? undefined : v; }, metadata: {fromCache: false, hasPendingWrites: false}}; }
  function snapOf(col, copy) {
    var m = colMap(col), docs = [];
    m.forEach(function (v, id) { docs.push(docSnap(id, copy ? clone(v) : v)); });
    return {docs: docs, size: docs.length, empty: !docs.length, metadata: {fromCache: false, hasPendingWrites: false}};
  }
  function safe(fn) { try { fn(); } catch (e) { console.error(e); } }
  function emitCol(col) { var s = colSubs.get(col); if (s) s.forEach(function (x) { safe(function () { x.cb(snapOf(col)); }); }); }
  function emitDoc(col, id) { var s = docSubs.get(col + '/' + id); if (s) s.forEach(function (x) { safe(function () { x.cb(docSnap(id, colMap(col).get(id))); }); }); }
  function emitKeys(keys) {
    var cols = new Set();
    keys.forEach(function (k) { var i = k.indexOf('/'); cols.add(k.slice(0, i)); emitDoc(k.slice(0, i), k.slice(i + 1)); });
    cols.forEach(emitCol);
  }
  function emitAll() {
    colSubs.forEach(function (_, col) { emitCol(col); });
    docSubs.forEach(function (_, k) { var i = k.indexOf('/'); emitDoc(k.slice(0, i), k.slice(i + 1)); });
  }
  function bumpCursor(t) { if (t && (!cursor || t > cursor)) cursor = t; }
  function applyRow(r) {
    if (LAZY.indexOf(r.col) >= 0) return false;
    if (pending.get(r.col + '/' + r.id)) return false;   // our own save is on its way; keep what we have
    var m = colMap(r.col);
    if (r.deleted) { if (!m.has(r.id)) return false; m.delete(r.id); return true; }
    var cur = m.get(r.id);
    if (cur !== undefined && JSON.stringify(cur) === JSON.stringify(r.data)) return false;
    m.set(r.id, r.data); return true;
  }

  async function withAuth(run) {
    var r = await run();
    if (r.error && (r.error.status === 401 || /JWT/i.test(r.error.message || ''))) { await sb.auth.refreshSession(); r = await run(); }
    return r;
  }
  async function fetchRows(since) {
    var out = [], from = 0, size = 1000;
    for (;;) {
      var r = await withAuth(function () {
        var q = sb.from('records').select('col,id,data,deleted,updated_at').eq('org_id', orgId)
          .not('col', 'in', '(' + LAZY.join(',') + ')')
          .order('updated_at', {ascending: true}).order('col', {ascending: true}).order('id', {ascending: true})
          .range(from, from + size - 1);
        return since ? q.gt('updated_at', since) : q.eq('deleted', false);
      });
      if (r.error) throw mapErr(r.error);
      out.push.apply(out, r.data);
      if (r.data.length < size) break;
      from += size;
    }
    return out;
  }

  async function initialLoad() {
    for (var wait = 2000; ; wait = Math.min(wait * 2, 30000)) {
      try {
        var rows = await fetchRows(null);
        rows.forEach(function (r) { applyRow(r); bumpCursor(r.updated_at); });
        loaded = true;
        colMap('inbox').forEach(function (_, id) { seenInbox.add(id); });
        emitAll(); health(true); live();
        return;
      } catch (e) {
        health(false);
        colSubs.forEach(function (s) { s.forEach(function (x) { if (x.err) safe(function () { x.err({code: e.code === 'not_granted' ? 'revoked' : 'unavailable'}); }); }); });
        await sleep(wait);
      }
    }
  }
  var loadP = initialLoad();

  async function sync() {
    if (!loaded) return;
    if (syncing) { again = true; return syncing; }
    syncing = (async function () {
      try {
        var since = cursor ? new Date(new Date(cursor).getTime() - 5000).toISOString() : null;
        var rows = await fetchRows(since);
        var changed = [];
        rows.forEach(function (r) { if (applyRow(r)) changed.push(r.col + '/' + r.id); bumpCursor(r.updated_at); });
        if (changed.length) { emitKeys(changed); noticeInbox(changed); }
        health(true);
      } catch (e) { health(false); }
      finally { syncing = null; if (again) { again = false; sync(); } }
    })();
    return syncing;
  }
  function noticeInbox(keys) {
    keys.forEach(function (k) {
      if (k.indexOf('inbox/') !== 0) return;
      var id = k.slice(6), v = colMap('inbox').get(id);
      if (!v || seenInbox.has(id)) return;
      seenInbox.add(id);
      var what = v.kind === 'details' ? 'Hire details' : v.kind === 'wait' ? 'Waiting list request' : 'Booking request';
      T.toast(what + ' from ' + (v.name || 'a customer') + '. It’s on Today.');
    });
  }
  var timer = 0;
  function soon(ms) { clearTimeout(timer); timer = setTimeout(sync, ms || 200); }
  function live() {
    try {
      sb.channel('records-' + orgId)
        .on('postgres_changes', {event: '*', schema: 'public', table: 'records', filter: 'org_id=eq.' + orgId}, function () { soon(250); })
        .subscribe(function (status) { if (status === 'SUBSCRIBED') soon(0); });
    } catch (e) { /* polling still runs */ }
    setInterval(function () { if (!document.hidden) sync(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) soon(0); });
    window.addEventListener('online', function () { soon(0); });
    window.addEventListener('focus', function () { soon(0); });
  }

  async function write(col, id, data, deleted) {
    var lazy = LAZY.indexOf(col) >= 0, key = col + '/' + id;
    if (!lazy) {
      if (deleted) colMap(col).delete(id); else colMap(col).set(id, data);
      pending.set(key, (pending.get(key) || 0) + 1);
    }
    try {
      var r = await withAuth(function () {
        return sb.from('records').upsert({org_id: orgId, col: col, id: id, data: deleted ? {} : data, deleted: !!deleted}, {onConflict: 'org_id,col,id'});
      });
      if (r.error) throw mapErr(r.error);
      health(true);
    } catch (e) {
      if (!e.code || e.code === 'unavailable') health(false);
      if (!lazy) { var n = (pending.get(key) || 1) - 1; if (n > 0) pending.set(key, n); else pending.delete(key); refetch(col, id); }
      lazy = true;   // pending already cleared
      throw e;
    } finally {
      if (!lazy) { var m = (pending.get(key) || 1) - 1; if (m > 0) pending.set(key, m); else pending.delete(key); }
    }
  }
  async function refetch(col, id) {
    try {
      var r = await sb.from('records').select('col,id,data,deleted,updated_at').eq('org_id', orgId).eq('col', col).eq('id', id).maybeSingle();
      if (r.error) return;
      var m = colMap(col);
      if (!r.data || r.data.deleted) m.delete(id); else m.set(id, r.data.data);
      emitKeys([col + '/' + id]);
    } catch (e) { /* leave it */ }
  }
  async function getOne(col, id) {
    if (LAZY.indexOf(col) < 0) { await loadP; return docSnap(id, clone(colMap(col).get(id))); }
    var r = await withAuth(function () { return sb.from('records').select('data,deleted').eq('org_id', orgId).eq('col', col).eq('id', id).maybeSingle(); });
    if (r.error) throw mapErr(r.error);
    return docSnap(id, r.data && !r.data.deleted ? r.data.data : undefined);
  }
  async function getAll(col) {
    if (LAZY.indexOf(col) < 0) { await loadP; return snapOf(col, true); }
    var docs = [], from = 0;
    for (;;) {
      var r = await withAuth(function () { return sb.from('records').select('id,data').eq('org_id', orgId).eq('col', col).eq('deleted', false).order('id').range(from, from + 999); });
      if (r.error) throw mapErr(r.error);
      r.data.forEach(function (x) { docs.push(docSnap(x.id, x.data)); });
      if (r.data.length < 1000) break; from += 1000;
    }
    return {docs: docs, size: docs.length, empty: !docs.length, metadata: {fromCache: false}};
  }
  function subscribe(map, key, cb, err, first) {
    var s = map.get(key); if (!s) { s = new Set(); map.set(key, s); }
    var x = {cb: cb, err: err}; s.add(x);
    if (loaded) Promise.resolve().then(function () { if (s.has(x)) safe(function () { cb(first()); }); });
    return function () { s.delete(x); };
  }
  function docRef(col, id) {
    return {
      id: id,
      set: function (obj) { return write(col, id, clone(obj), false); },
      delete: function () { return write(col, id, null, true); },
      get: function () { return getOne(col, id); },
      onSnapshot: function (cb, err) { return subscribe(docSubs, col + '/' + id, cb, err, function () { return docSnap(id, colMap(col).get(id)); }); }
    };
  }
  function split(path) { var i = path.indexOf('/'); return [path.slice(0, i), path.slice(i + 1)]; }
  return {
    collection: function (col) {
      return {
        doc: function (id) { return docRef(col, id); },
        get: function () { return getAll(col); },
        onSnapshot: function (cb, err) { return subscribe(colSubs, col, cb, err, function () { return snapOf(col); }); }
      };
    },
    doc: function (path) { var p = split(path); return docRef(p[0], p[1]); }
  };
}

var pillT = 0, bad = 0;
function health(ok) {
  bad = ok ? 0 : bad + 1;
  clearTimeout(pillT);
  pillT = setTimeout(function () {
    var el = $('#pf-pill');
    if (bad >= 2) {
      injectStyle();
      if (!el) { el = document.createElement('div'); el.id = 'pf-pill'; el.className = 'pf-pill'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
      el.textContent = 'Offline. Changes might not save until you’re back online.';
    } else if (el) el.remove();
  }, 400);
}

/* ---------- downloads ---------- */
function saveDownload(o) {
  var MIME = {csv: 'text/csv', json: 'application/json', html: 'text/html', txt: 'text/plain', ics: 'text/calendar', pdf: 'application/pdf'};
  var name = o.filename || 'download';
  var ext = (name.split('.').pop() || '').toLowerCase();
  var data = o.data;
  var blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], {type: (MIME[ext] || 'application/octet-stream') + ';charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  return Promise.resolve(true);
}

/* ---------- photos and documents ---------- */
var URLS = new Map(), FAILED = new Map(), queue = new Set(), signT = 0;
function assetUrl(id) {
  if (!id || !ORG) return '';
  var hit = URLS.get(id); if (hit && hit.exp > Date.now()) return hit.url;
  var f = FAILED.get(id); if (f && f > Date.now()) return '';
  queue.add(id); clearTimeout(signT); signT = setTimeout(flushSign, 30);
  return BLANK;
}
async function flushSign() {
  var ids = Array.from(queue).slice(0, 100);
  ids.forEach(function (i) { queue.delete(i); });
  if (!ids.length) return;
  try {
    var r = await sb.storage.from('assets').createSignedUrls(ids.map(function (i) { return ORG.id + '/' + i; }), 12 * 3600);
    (r.data || []).forEach(function (d, n) {
      if (d && d.signedUrl) URLS.set(ids[n], {url: d.signedUrl, exp: Date.now() + 11 * 3600e3});
      else FAILED.set(ids[n], Date.now() + 10 * 60e3);
    });
    if (r.error) ids.forEach(function (i) { if (!URLS.has(i)) FAILED.set(i, Date.now() + 60e3); });
  } catch (e) { ids.forEach(function (i) { FAILED.set(i, Date.now() + 60e3); }); }
  T.bump();
  if (queue.size) flushSign();
}
function storageErr(e) {
  var m = String(e && (e.message || e.error) || ''), s = e && (e.statusCode || e.status);
  if (/too large|exceeded the maximum|413/i.test(m) || +s === 413) return {code: 'too_large'};
  if (/mime|type/i.test(m) && /not supported|invalid/i.test(m)) return {code: 'unsupported_type'};
  if (/row-level security|unauthorized|403/i.test(m) || +s === 403) return {code: 'not_granted'};
  if (/jwt|401/i.test(m) || +s === 401) return {code: 'upstream_auth'};
  return {code: 'store_unavailable'};
}
function makeAssets(orgId) {
  return {
    upload: async function (blob, o) {
      var type = (o && o.type) || blob.type || 'image/jpeg';
      var ext = type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      var id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, '') + '.' + ext;
      var r = await sb.storage.from('assets').upload(orgId + '/' + id, blob, {contentType: type, upsert: false, cacheControl: '31536000'});
      if (r.error) throw storageErr(r.error);
      var s = await sb.storage.from('assets').createSignedUrl(orgId + '/' + id, 12 * 3600);
      var url = s.data && s.data.signedUrl || '';
      if (url) URLS.set(id, {url: url, exp: Date.now() + 11 * 3600e3});
      return {id: id, url: url, sizeBytes: blob.size};
    },
    delete: async function (id) {
      var r = await sb.storage.from('assets').remove([orgId + '/' + id]);
      URLS.delete(id);
      if (r.error) throw storageErr(r.error);
    },
    list: async function () {
      var files = 0, bytes = 0;
      for (var off = 0; off < 20000; off += 1000) {
        var r = await sb.storage.from('assets').list(orgId, {limit: 1000, offset: off});
        if (r.error) throw storageErr(r.error);
        r.data.forEach(function (f) { files++; bytes += +(f.metadata && f.metadata.size) || 0; });
        if (r.data.length < 1000) break;
      }
      return {usage: {files: files, bytes: bytes}};
    }
  };
}

/* Settings restored from a backup made in Claude point at Claude pages. */
function fixSettings(s) {
  s = clone(s || {});
  if (/claude\.ai\//.test(s.formUrl || '')) s.formUrl = P.formUrl();
  if (/claude\.ai\//.test(s.publicUrl || '')) s.publicUrl = P.bookingUrl();
  return s;
}

/* ---------------------------------------------------------------------
   Account and team panel (button in the top bar)
   --------------------------------------------------------------------- */
function initials() {
  var n = displayName().replace(/@.*/, '').trim().split(/[\s._-]+/).filter(Boolean);
  return ((n[0] || '?')[0] + (n[1] ? n[1][0] : '')).toUpperCase();
}
function mountAccount() {
  injectStyle();
  var bar = $('.bar'); if (!bar || $('#pf-acct')) return;
  var b = document.createElement('button');
  b.type = 'button'; b.id = 'pf-acct'; b.className = 'pf-acct'; b.textContent = initials();
  b.setAttribute('aria-label', 'Your account and team'); b.title = 'Account and team';
  b.addEventListener('click', openPanel);
  bar.appendChild(b);
}
function closePanel() { var s = $('#pf-sheet'); if (s) s.remove(); var b = $('#pf-acct'); if (b) b.focus(); }
function copy(text, btn) {
  var done = function () { if (btn) { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1500); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this link', text); });
  else window.prompt('Copy this link', text);
}
function openPanel() {
  closePanel();
  var owner = ORG.role === 'owner';
  var s = document.createElement('div'); s.id = 'pf-sheet'; s.className = 'pf-sheet';
  s.innerHTML = '<div class="pf-panel" role="dialog" aria-modal="true" aria-labelledby="pf-pt">' +
    '<div class="pf-ph"><h2 id="pf-pt">' + esc(ORG.name) + '</h2><button type="button" class="pf-b sm" data-x>Close</button></div>' +
    '<p class="pf-mute" style="margin:0">Signed in as ' + esc(USER.email) + ' · ' + (owner ? 'Owner' : 'Staff') + '</p>' +
    '<h3>Your customer links</h3>' +
    '<p class="pf-mute" style="margin:0">Booking page</p><code class="pf-code">' + esc(P.bookingUrl()) + '</code>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pf-b sm" data-copy="' + esc(P.bookingUrl()) + '">Copy link</button><a class="pf-b sm" href="' + esc(P.bookingUrl()) + '" target="_blank" rel="noopener">Open it</a></div>' +
    '<p class="pf-mute" style="margin:12px 0 0">Switch the booking page on, and pick which cars show, in Setup.</p>' +
    '<h3>Team</h3><div id="pf-team"><div class="pf-spin" aria-hidden="true"></div></div>' +
    (owner ? '<form id="pf-inv" novalidate style="margin-top:16px"><label class="pf-l"><span>Add someone</span><input name="email" type="email" inputmode="email" autocomplete="off" placeholder="their@email.com" class="pf-in"></label>' +
      '<div class="pf-inline"><select name="role" class="pf-in" aria-label="Role"><option value="staff">Staff: uses the tracker</option><option value="owner">Owner: also manages the team</option></select><button type="submit" class="pf-b sm pri" style="min-height:48px">Add</button></div>' +
      '<p class="pf-mute" style="margin:8px 0 0">They create an account with that email at <b>' + esc(location.host) + '/staff</b> and they’re in.</p><p id="pf-invmsg" class="pf-mute" role="status"></p></form>' : '') +
    (BIZ.length > 1 ? '<h3>Other businesses</h3><div class="pf-list">' + BIZ.filter(function (b) { return b.id !== ORG.id; }).map(function (b) {
      return '<button type="button" class="pf-b" data-switch="' + esc(b.id) + '"><span>' + esc(b.name) + '</span><span class="pf-mute">Open</span></button>'; }).join('') + '</div>' : '') +
    '<h3>Account</h3><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pf-b sm" data-pw>Change password</button><button type="button" class="pf-b sm danger" data-out>Sign out</button></div>' +
    '<p class="pf-mute" style="margin-top:22px">Customer details are personal data. Only add people who work in the business, and remove them when they leave.</p>' +
    '</div>';
  document.body.appendChild(s);
  s.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t === s || t.closest('[data-x]')) return closePanel();
    var c = t.closest('[data-copy]'); if (c) return copy(c.dataset.copy, c);
    var sw = t.closest('[data-switch]'); if (sw) { try { localStorage.setItem(LAST_ORG, sw.dataset.switch); } catch (e) { /* ignore */ } location.reload(); return; }
    if (t.closest('[data-out]')) return signOut();
    if (t.closest('[data-pw]')) return changePassword(t.closest('[data-pw]'));
    var rm = t.closest('[data-rm]'); if (rm) return removeMember(rm.dataset.rm, rm.dataset.email);
    var ci = t.closest('[data-cancel]'); if (ci) return cancelInvite(ci.dataset.cancel);
    var rl = t.closest('[data-role]'); if (rl) return setRole(rl.dataset.user, rl.dataset.role);
  });
  s.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePanel(); });
  var inv = $('#pf-inv');
  if (inv) inv.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var d = Object.fromEntries(new FormData(inv).entries()), msg = $('#pf-invmsg');
    var r = await sb.rpc('invite_member', {p_org: ORG.id, p_email: d.email || '', p_role: d.role});
    var e = r.error ? authText(r.error) : r.data && r.data.error;
    msg.textContent = !e ? 'Added. Tell them to sign up with ' + (d.email || '').trim().toLowerCase() + '.' :
      e === 'bad_email' ? 'That email doesn’t look right.' : e === 'already_member' ? 'They’re already on the team.' : e === 'too_many' ? 'Too many invites waiting. Cancel some first.' : e;
    if (!e) { inv.reset(); loadTeam(); }
  });
  $('[data-x]', s).focus();
  loadTeam();
}
async function loadTeam() {
  var box = $('#pf-team'); if (!box) return;
  var r = await sb.rpc('team', {p_org: ORG.id});
  if (r.error || !r.data || r.data.error) { box.innerHTML = '<p class="pf-mute">Couldn’t load the team. Check your connection.</p>'; return; }
  var owner = ORG.role === 'owner', owners = r.data.members.filter(function (m) { return m.role === 'owner'; }).length;
  box.innerHTML = r.data.members.map(function (m) {
    var canRm = (owner || m.you) && !(m.role === 'owner' && owners <= 1);
    var flip = owner && !m.you ? '<button type="button" class="pf-b sm" data-role="' + (m.role === 'owner' ? 'staff' : 'owner') + '" data-user="' + esc(m.user_id) + '">' + (m.role === 'owner' ? 'Make staff' : 'Make owner') + '</button>' : '';
    return '<div class="pf-row"><div class="who">' + esc(m.email || 'Someone') + (m.you ? ' (you)' : '') + '<small>' + (m.role === 'owner' ? 'Owner' : 'Staff') + '</small></div><div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">' + flip +
      (canRm ? '<button type="button" class="pf-b sm danger" data-rm="' + esc(m.user_id) + '" data-email="' + esc(m.email || '') + '">' + (m.you ? 'Leave' : 'Remove') + '</button>' : '') + '</div></div>';
  }).join('') + r.data.invites.map(function (i) {
    return '<div class="pf-row"><div class="who">' + esc(i.email) + '<small>Added, not signed up yet · ' + (i.role === 'owner' ? 'Owner' : 'Staff') + '</small></div><button type="button" class="pf-b sm" data-cancel="' + esc(i.id) + '">Cancel</button></div>';
  }).join('');
}
async function removeMember(uid, email) {
  var me = uid === USER.id;
  if (!window.confirm(me ? 'Leave ' + ORG.name + '? You’ll lose access to its tracker.' : 'Remove ' + (email || 'this person') + ' from ' + ORG.name + '? They lose access straight away.')) return;
  var r = await sb.rpc('remove_member', {p_org: ORG.id, p_user: uid});
  if (r.error || (r.data && r.data.error)) { window.alert(r.data && r.data.error === 'last_owner' ? 'Add another owner first.' : 'Couldn’t do that. Try again.'); return; }
  if (me) { try { localStorage.removeItem(LAST_ORG); } catch (e) { /* ignore */ } location.reload(); return; }
  loadTeam();
}
async function cancelInvite(id) { await sb.rpc('cancel_invite', {p_org: ORG.id, p_invite: id}); loadTeam(); }
async function setRole(uid, role) {
  var r = await sb.rpc('set_member_role', {p_org: ORG.id, p_user: uid, p_role: role});
  if (r.data && r.data.error === 'last_owner') window.alert('There has to be at least one owner.');
  loadTeam();
}
function changePassword(btn) {
  if ($('#pf-cpw')) return;
  var f = document.createElement('form'); f.id = 'pf-cpw'; f.noValidate = true; f.className = 'pf-f'; f.style.marginTop = '12px';
  f.innerHTML = field('New password', '<input name="password" type="password" autocomplete="new-password" minlength="8" class="pf-in">', 'At least 8 characters.') +
    field('Type it again', '<input name="again" type="password" autocomplete="new-password" class="pf-in">') +
    '<p class="pf-mute" id="pf-cpwmsg" role="status" style="margin:0"></p><button type="submit" class="pf-b sm pri" style="min-height:44px">Save new password</button>';
  btn.parentNode.insertAdjacentElement('afterend', f);
  f.querySelector('input').focus();
  f.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var d = Object.fromEntries(new FormData(f).entries()), msg = $('#pf-cpwmsg');
    if ((d.password || '').length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
    if (d.password !== d.again) { msg.textContent = 'The two passwords don\u2019t match.'; return; }
    var r = await sb.auth.updateUser({password: d.password});
    if (r.error) { msg.textContent = authText(r.error); return; }
    f.innerHTML = '<p class="pf-ok" style="margin:0">Password changed.</p>';
  });
}

function go() { start().catch(function (e) { console.error(e); showFatal('Something went wrong', 'Reload the page to try again.'); }); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
