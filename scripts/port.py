#!/usr/bin/env python3
"""Ports the tracker and booking page built in Claude to the live site.

Usage: python3 scripts/port.py <tracker.html> <book.html>
Writes site/staff/index.html and site/book/index.html. (The hire details form was ported by hand.)
Every edit must match exactly once, so a changed source fails loudly instead of half-porting.
"""
import sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def patch(src, edits, name):
    for old, new, *count in edits:
        n = src.count(old)
        want = count[0] if count else 1
        if n != want:
            sys.exit(f'{name}: expected {want} match(es) for edit, found {n}:\n{old[:200]}')
        src = src.replace(old, new)
    return src


HEAD_COMMON = '''<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="theme-color" content="#15171a">'''

# ---------------------------------------------------------------- tracker
TRACKER = [
    ('''<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap" rel="stylesheet">''',
     HEAD_COMMON + '''
<link rel="manifest" href="/staff/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Tracker">
<meta name="robots" content="noindex">
<script src="/config.js"></script>
<script src="/vendor/supabase.js"></script>
<script src="/staff/platform.js"></script>'''),
    ('</style>\n</head>', '.row.inb{box-shadow:inset 4px 0 0 var(--y)}\n</style>\n</head>'),

    # storage, photos and start-up go through the platform layer
    ("const assetUrl = id => id ? (ASSET_URLS.get(id) || '/_blob/' + id) : '';",
     "const assetUrl = id => id ? (window.PLATFORM && window.PLATFORM.assetUrl ? window.PLATFORM.assetUrl(id) : (ASSET_URLS.get(id) || '/_blob/' + id)) : '';"),
    ("'promos', 'incidents', 'owners', 'cashbook'];", "'promos', 'incidents', 'owners', 'cashbook', 'inbox'];"),
    ("const FORM_URL = 'https://claude.ai/artifact/WSQzTrT84U8LDtpqz9B5bB';", "let FORM_URL = '';"),
    ("const BOOK_URL = 'https://claude.ai/artifact/DT7uMKpLk3ERvuCbGuYwGt';", "let BOOK_URL = '';"),
    ("  const cl = await waitClaude(1500);",
     "  if (window.PLATFORM) window.PLATFORM.attach({bump: bump, toast: toast});\n"
     "  const cl = window.PLATFORM ? await window.PLATFORM.ready : await waitClaude(1500);\n"
     "  if (window.PLATFORM && cl) { BOOK_URL = window.PLATFORM.bookingUrl(); FORM_URL = window.PLATFORM.formUrl(); }"),
    ("  if (data.settings) await saveSettings(data.settings);",
     "  if (data.settings) await saveSettings(window.PLATFORM && S.mode === 'db' ? window.PLATFORM.fixSettings(data.settings) : data.settings);"),

    # wording that only made sense inside Claude
    ("toast('You don\\'t have edit access, so that wasn\\'t saved. Ask the owner to make you an Editor from the Share menu.');",
     "toast('You don\\'t have access to change this business\\'s records, so that wasn\\'t saved. Ask the owner to check you\\'re on the team.');"),
    ("toast('View only. Ask the owner to add you as an editor to make changes.');", "toast('View only. Ask the owner to add you to the team to make changes.');"),
    ("toast('View only. Ask the owner to add you as an editor.');", "toast('View only. Ask the owner to add you to the team.');"),
    ("const modeTxt = S.mode === 'db' ? (S.readOnly ? 'Customer and booking records are only shown to Editors, so they are hidden from you. The owner can make you an Editor from the Share menu.' : 'Records are saved to this tracker\\'s shared database. Anyone the owner shares it with as an Editor sees the same bookings, live.') : 'This is a preview copy, so records are only saved in this browser. Open the published tracker on claude.ai to use shared records.';",
     "const modeTxt = S.mode === 'db' ? (S.readOnly ? 'You don\\'t have access to this business\\'s records. The owner can add you to the team from the account button, top right.' : 'Records are saved to your business\\'s account online. Everyone on your team sees the same bookings, live. Owners add and remove people from the account button, top right.') : 'This is a demo copy, so records are only saved in this browser. Sign in at /staff to use your live tracker.';"),
    ("return 'Saving photos needs Editor access to this tracker.';", "return 'Saving photos needs you to be on this business\\'s team.';"),
    ("(CAP.assets === null && S.mode === 'db' ? 'Photos are saved here for people with Editor access. ' : 'Photos work in the published tracker. ')",
     "(CAP.assets === null && S.mode === 'db' ? 'Photos are saved here for people on the team. ' : 'Photos are saved once you sign in to the live tracker. ')"),
    ("Reading other chats needs Claude, which isn\\'t available here.", "Reading other chats automatically isn\\'t switched on yet."),
    ("warn('Claude isn\\'t available here, so this chat can\\'t be read. Make the booking by hand, or paste a reply from your booking form.')",
     "warn('Reading chats automatically isn\\'t switched on yet. Make the booking by hand, or paste a request from your booking page or form.')"),
    ("' Documents need Editor access.'", "' Documents need you to be on the team.'"),
    ("It comes back to you as one WhatsApp message, and Paste a chat reads it straight in.",
     "It lands on your Today page, ready to add to the booking. Customers can still send it on WhatsApp if they prefer."),
    ("'<div class=\"box2\"><p><b>Yours is built.</b> Customers can only open it once it\\'s public:</p><ol><li>Open it and press Share.</li><li>Choose anyone with the link.</li><li>Come back and press the button below.</li></ol><div class=\"btns\">",
     "'<div class=\"box2\"><p><b>Yours is ready.</b> Switch it on and every booking message includes the customer\\'s own link.</p><div class=\"btns\">"),
    ("data-act=\"form-use\">It\\'s public, use it</button>", "data-act=\"form-use\">Switch it on</button>"),
    ("{ph: 'https://claude.ai/artifact/…', type: 'text'}", "{ph: 'https://…', type: 'text'}"),
    ("Requests go to that number on WhatsApp, or to the WhatsApp number below if it\\'s different.</li><li>Open the page, press Share and choose anyone with the link.</li><li>Press Switch it on.</li></ol>",
     "Customers can also message that number on WhatsApp, or the WhatsApp number below if it\\'s different.</li><li>Press Switch it on.</li></ol>"),
    ("'. The page copies it every few hours.' : 'Availability is saved for the page while this tracker is open.')",
     "'. It updates within a minute of any change.' : 'Availability is saved for the page whenever this tracker is open on any device.')"),
    ("and send a request on WhatsApp. No names, numbers or bookings are ever on it, only which cars are free when. It updates from this tracker every few hours. Requests come in as one message: paste it into Paste a chat and the booking fills itself in.",
     "and send you a request. No names, numbers or bookings are ever on it, only which cars are free when. It updates from this tracker within a minute. Requests land on your Today page, ready to open as a booking."),
    ("It shows your cars within a few hours.", "Your cars show on it within a minute."),
    ("<div class=\"banner red\"><p>The records here are only shown to Editors, and you don\\'t have edit access. Ask the owner to make you an Editor from the Share menu.</p></div>",
     "<div class=\"banner red\"><p>You don\\'t have access to this business\\'s records. Ask the owner to add you to the team.</p></div>"),
    ("<div class=\"banner info\"><p>Preview copy. Changes are saved in this browser only.</p></div>",
     "<div class=\"banner info\"><p>Demo copy with example data. Changes are saved in this browser only. <a href=\"/staff\">Sign in</a> to use your live tracker.</p></div>"),
    ("(S.readOnly ? 'Shared tracker, view only' : 'Shared tracker, saves live') : S.mode === 'local' ? 'Preview copy, saved in this browser'",
     "(S.readOnly ? 'Live tracker, view only' : 'Live tracker, saves as you go') : S.mode === 'local' ? 'Demo copy, saved in this browser'"),

    # the inbox: requests and forms customers send from the booking page
    ("const badges = {today: red, bookings: overdue,",
     "const badges = {today: red + inboxNew(), bookings: overdue,"),
    ("    '<div class=\"board-keys\" aria-label=\"Key board\">",
     "    inboxPanel() + '<div class=\"board-keys\" aria-label=\"Key board\">"),
    ("const ACT = {", r"""/* ---------- inbox: requests and forms customers send from the booking page ---------- */
const INBOX_KIND = {booking: ['Booking request', 'plus'], wait: ['Waiting list', 'clock'], details: ['Hire details', 'file']};
function inboxItems(){ return [...S.inbox.values()].filter(x => x && x.message).sort((a, b) => String(b.at || b.createdAt || '').localeCompare(String(a.at || a.createdAt || ''))); }
function inboxNew(){ return S.inbox ? inboxItems().filter(x => !x.openedAt).length : 0; }
function inboxSummary(x){
  if (x.kind === 'details') return (x.ref ? 'For booking ' + x.ref : 'For a booking') + (x.phone ? ' · ' + x.phone : '');
  const L = msgLines(x.message);
  return [L.car || L.wanted || '', L.collect ? L.collect + (L['return'] ? ' to ' + L['return'] : '') : ''].filter(Boolean).join(' · ') || x.phone || '';
}
function inboxPanel(){
  const L = inboxItems(); if (!L.length) return '';
  return '<section class="sec"><h2>From your booking page <span class="mute">' + L.length + '</span></h2><div class="list">' + L.slice(0, 12).map(x => {
    const k = INBOX_KIND[x.kind] || INBOX_KIND.booking;
    return '<div class="row' + (x.openedAt ? '' : ' inb') + '"><span class="lead">' + icon(k[1]) + '</span><span><span class="t">' + esc(k[0] + ' from ' + (x.name || 'a customer')) + (x.openedAt ? '' : ' <span class="mute small">New</span>') + '</span><span class="s">' + esc(inboxSummary(x)) + ' · sent ' + esc(whenShort(String(x.at || x.createdAt || '').slice(0, 16))) + '</span></span>' +
      '<span class="r rowbtns"><button type="button" class="btn sm primary" data-act="inbox-open" data-id="' + esc(x.id) + '">Open</button><button type="button" class="btn sm" data-act="inbox-done" data-id="' + esc(x.id) + '">Done</button></span></div>';
  }).join('') + '</div>' + (L.length > 12 ? '<p class="small mute" style="margin-top:8px">And ' + (L.length - 12) + ' more. Press Done on the ones you\'ve dealt with.</p>' : '') + '</section>';
}
EXT.act['inbox-open'] = el => {
  const x = S.inbox.get(el.dataset.id); if (!x) return;
  if (!x.openedAt) put('inbox', Object.assign(clone(x), {openedAt: new Date().toISOString()}));
  if (x.kind === 'details') { const f = parseFormMessage(x.message); if (f) { shFormDetails(f); return; } }
  else { const r = parseRequestMessage(x.message); if (r) { if (r.kind === 'wait') shLeadForm(null, r.lead); else shBookingForm(null, r.pre); return; } }
  copyText(x.message);
};
EXT.act['inbox-done'] = el => {
  const x = S.inbox.get(el.dataset.id); if (!x) return;
  del('inbox', x.id).then(ok => { if (ok) toast('Cleared', {undo: () => put('inbox', x)}); });
};

const ACT = {"""),

    # photo of the actual car for the booking page
    ("'</div></fieldset>' +\n    '<fieldset class=\"fset\"><legend>Prices</legend>",
     "'</div>' + carPhotoField(c) + '</fieldset>' +\n    '<fieldset class=\"fset\"><legend>Prices</legend>"),
    ("  if (f.ulez === 'yes') c.ulez = true;",
     "  const oldPhoto = ex && ex.photoPath;\n"
     "  if (form._photo) { if (form._photo.url) { c.photoUrl = form._photo.url; c.photoPath = form._photo.path; } else { delete c.photoUrl; delete c.photoPath; } }\n"
     "  if (f.ulez === 'yes') c.ulez = true;"),
    ("  const sh = topSheet(); await put('cars', c); closeSheet(sh); toast(ex ? 'Car saved' : plate + ' added to the fleet');",
     "  const sh = topSheet(); const saved = await put('cars', c); closeSheet(sh); toast(ex ? 'Car saved' : plate + ' added to the fleet');\n"
     "  if (saved && oldPhoto && oldPhoto !== c.photoPath && window.PLATFORM && window.PLATFORM.carPhotos) window.PLATFORM.carPhotos.remove(oldPhoto);"),
    ("ulez: c.ulez === false ? false : c.ulez === true ? true : null}))",
     "ulez: c.ulez === false ? false : c.ulez === true ? true : null, photo: /^https?:\\/\\//.test(c.photoUrl || '') ? c.photoUrl : ''}))"),
    (".row.inb{box-shadow:inset 4px 0 0 var(--y)}",
     ".row.inb{box-shadow:inset 4px 0 0 var(--y)}\n.cpic{width:100%;max-width:380px;aspect-ratio:16/10;border-radius:10px;overflow:hidden;background:var(--panel);border:1px solid var(--line);display:grid;place-items:center;text-align:center;margin:6px 0 10px}\n.cpic img{width:100%;height:100%;object-fit:cover;display:block}\n.cpic .small{padding:0 16px}"),
    ("const ACT = {", r"""/* ---------- photo of the actual car, for the booking page ---------- */
function carPhotoField(c){
  if (!(window.PLATFORM && window.PLATFORM.carPhotos && S.mode === 'db')) return '';
  return '<div class="field" id="cr-photo">' + carPhotoInner(c.photoUrl || '') + '</div>';
}
function carPhotoInner(url){
  return '<span>Photo for your booking page</span><div class="cpic">' + (url ? '<img src="' + esc(url) + '" alt="">' : '<span class="mute small">No photo yet. Customers see a drawing of the car in its colour.</span>') + '</div>' +
    '<div class="btns"><label class="btn sm" for="cr-pic">' + icon('camera') + (url ? 'Change photo' : 'Add a photo') + '</label>' + filePick('cr-pic', 'data-pick="carpic"', 'image/*') +
    (url ? '<button type="button" class="btn sm quiet" data-act="carpic-del">' + icon('trash') + 'Remove</button>' : '') + '</div>' +
    '<small class="hint">Shoot it side-on or from the front corner, in daylight, with the plate out of shot or blurred. The booking page is public, and cloned plates are a real problem.</small>';
}
EXT.change.push(t => {
  if (!(t.dataset && t.dataset.pick === 'carpic')) return;
  const file = t.files && t.files[0]; const form = t.closest('form'); t.value = '';
  if (!file || !form) return true;
  const box = $('#cr-photo', form); const pic = box.querySelector('.cpic'); pic.innerHTML = '<span class="mute small">Uploading…</span>';
  (async () => {
    try { const blob = await shrinkImage(file, 1600, 0.82); const r = await window.PLATFORM.carPhotos.upload(blob); form._photo = r; box.innerHTML = carPhotoInner(r.url); }
    catch (e) { box.innerHTML = carPhotoInner(form._photo ? form._photo.url : ((S.cars.get(form.dataset.id) || {}).photoUrl || '')); toast(assetError(e)); }
  })();
  return true;
});
EXT.act['carpic-del'] = el => { const form = el.closest('form'); form._photo = {url: '', path: ''}; $('#cr-photo', form).innerHTML = carPhotoInner(''); };

const ACT = {"""),
]

# ---------------------------------------------------------------- booking page
BOOK = [
    ('''<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@600;700&display=swap" rel="stylesheet">''',
     HEAD_COMMON + '''
<script src="/config.js"></script>
<script src="/shared/public.js"></script>'''),
    ("Send a request and we'll confirm on WhatsApp.</p>", "Send a request and we'll message you to confirm.</p>"),
    ("Send a request and we\\'ll confirm on WhatsApp.';", "Send a request and we\\'ll message you to confirm.';"),
    ("<p>Pick your dates and a car, add any extras, and send the request. It goes to us as one WhatsApp message.</p>",
     "<p>Pick your dates and a car, add any extras, and send the request. It comes straight to us.</p>"),
    # send straight to the business; WhatsApp and copy stay as a back-up
    ("""  function sendButtons(kind){
    const b = B(); const wa = b.whatsapp;""",
     """  function sendButtons(kind){
    const b = B(); const wa = b.whatsapp; const direct = HIRE.connected && DATA && DATA.on;
    if (direct) return '<button type="button" class="btn primary block" id="send-direct">' + icon('send') + 'Send ' + kind + '</button>' +
      '<details class="alt"><summary>Or send it yourself' + (wa ? ' on WhatsApp' : '') + '</summary><div class="pair">' +
      (wa ? '<a class="btn" id="send-wa" href="#" target="_blank" rel="noopener">' + icon('wa') + 'WhatsApp</a>' : '') +
      '<button type="button" class="btn" id="send-copy">' + icon('copy') + 'Copy it</button></div></details>';"""),
    ("    wireSend(() => validateReq(c), () => reqMessage(c));",
     "    wireSend(() => validateReq(c), () => reqMessage(c), 'booking');"),
    ("    wireSend(validate, message);\n  }",
     "    wireSend(validate, message, 'wait');\n  }"),
    ("""  function wireSend(validate, message){
    const wa = $('#send-wa'), cp = $('#send-copy');
    const show = t => { $('#r-msg').textContent = t; $('#r-done').hidden = false; };""",
     """  function wireSend(validate, message, kind){
    const wa = $('#send-wa'), cp = $('#send-copy'), dr = $('#send-direct');
    const show = t => { $('#r-msg').textContent = t; $('#r-done').hidden = false; };
    if (dr) dr.addEventListener('click', () => {
      if (!validate()) return;
      const t = message(); const name = ($('#r-name') || {}).value || ''; const phone = ($('#r-phone') || {}).value || '';
      dr.disabled = true; dr.lastChild.nodeValue = 'Sending…';
      HIRE.submit(kind, t, name.trim(), phone.trim(), '').then(() => {
        $('#sheet-b').innerHTML = '<div class="done" id="r-done"><h3>' + (kind === 'wait' ? 'You\\'re on the list' : 'Request sent') + '</h3><p>' +
          esc(kind === 'wait' ? 'We\\'ll message you on ' + phone.trim() + ' if it frees up.' : 'We\\'ll message you on ' + phone.trim() + ' to confirm. Nothing is booked until we do, and nothing is paid on this page.') + '</p></div>';
        $('#sheet-b').scrollTop = 0; $('#sheet-f').innerHTML = '<button type="button" class="btn primary block" id="send-close">Done</button>';
        $('#send-close').addEventListener('click', closeSheet);
      }).catch(e => {
        dr.disabled = false; dr.lastChild.nodeValue = 'Try again';
        const er = $('#r-err'); er.textContent = HIRE.errorText(e); er.hidden = false;
        const d = $('#sheet-f details'); if (d) d.open = true;
      });
    });"""),
    ("    cp.addEventListener('click', () => {", "    if (cp) cp.addEventListener('click', () => {"),
    # data comes from the live database, by the business's page address
    ("""  fetch('availability.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !Array.isArray(d.cars)) throw new Error('no data');
    DATA = d; render(); chrome();
  }).catch(() => {
    $('#rtitle').textContent = 'The cars couldn\\'t load just now'; $('#rsub').textContent = 'Refresh the page in a minute, or message us with your dates.';
  });""",
     """  HIRE.page().then(res => {
    if (!res) { $('#rtitle').textContent = 'We couldn\\'t find this booking page'; $('#rsub').textContent = 'Check the link you were sent.'; document.title = 'Page not found'; return; }
    const d = res.page;
    if (!d || !Array.isArray(d.cars)) { $('#rtitle').textContent = res.name + ' is setting up this page'; $('#rsub').textContent = 'Message them with your dates for now.'; $('#biz').firstChild.nodeValue = res.name; return; }
    if (d.business && !d.business.name) d.business.name = res.name;
    DATA = d; render(); chrome();
  }).catch(() => {
    $('#rtitle').textContent = 'The cars couldn\\'t load just now'; $('#rsub').textContent = 'Refresh the page in a minute, or message us with your dates.';
  });"""),
    ("'<p>Availability is copied from our bookings every few hours' + (up ? ' (last change ' + esc(fmtDT(up.getTime())) + ')' : '') + ', so a car can go before it shows here. Every booking is confirmed by message. Nothing is paid on this page.</p>'",
     "'<p>Availability comes from our live bookings' + (up ? ' (last change ' + esc(fmtDT(up.getTime())) + ')' : '') + '. Every booking is confirmed by message. Nothing is paid on this page. Your details are only used to arrange your hire.</p>'"),
    ("  const icon = n => '<svg class=\"ic\"", "  IC.send = '<path d=\"M4 12 20 4l-5 16-3.5-6.5z\"/><path d=\"m11.5 13.5 3-3\"/>';\n  const icon = n => '<svg class=\"ic\""),
    ("</style>", ".alt{margin-top:10px}.alt summary{cursor:pointer;font-weight:600;color:var(--blue,#0b4fb3);padding:6px 0}.alt .pair{margin-top:8px}\n</style>"),
    # a real photo of the car when the business has added one, the drawing when not
    ("<div class=\"pic\">' + carSvg(c) + '</div><div class=\"cbody\">",
     "' + (/^https?:\\/\\//.test(c.photo || '') ? '<div class=\"pic ph\"><img class=\"carph\" data-id=\"' + esc(c.id) + '\" src=\"' + esc(c.photo) + '\" alt=\"' + esc(c.make + ' ' + c.model) + '\" loading=\"lazy\"></div>' : '<div class=\"pic\">' + carSvg(c) + '</div>') + '<div class=\"cbody\">"),
    ("No cars match. Try all types.</div>';",
     "No cars match. Try all types.</div>';\n    $$('#grid img.carph').forEach(i => i.addEventListener('error', () => { const c = car(i.dataset.id); const p = i.parentNode; p.classList.remove('ph'); p.innerHTML = c ? carSvg(c) : ''; }, {once: true}));"),
    (".alt{margin-top:10px}", ".pic.ph{padding:0;aspect-ratio:16/10;overflow:hidden}.pic.ph img{width:100%;height:100%;object-fit:cover;display:block}\n.alt{margin-top:10px}"),
]

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    jobs = [(sys.argv[1], TRACKER, 'site/staff/index.html'), (sys.argv[2], BOOK, 'site/book/index.html')]
    for src, edits, out in jobs:
        text = pathlib.Path(src).read_text()
        text = patch(text, edits, out)
        if 'claude.ai/artifact' in text:
            sys.exit(out + ': still mentions claude.ai/artifact')
        (ROOT / out).write_text(text)
        print('wrote', out, len(text))
