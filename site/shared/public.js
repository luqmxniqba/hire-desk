/* Customer pages talk to the database through two public functions only:
   public_page (what the booking page shows) and submit_inbox (a request or form).
   Neither needs sign-in, and neither can read anything else. */
window.HIRE = (function () {
  'use strict';
  var cfg = window.APP_CONFIG || {};
  var parts = location.pathname.split('/').filter(Boolean);
  var slug = (parts[0] || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) slug = '';
  var base = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
  var connected = !!base && !/YOUR-PROJECT/.test(base) && !!cfg.supabaseKey && !/YOUR-/.test(cfg.supabaseKey);

  function headers() {
    var h = {'Content-Type': 'application/json', apikey: cfg.supabaseKey};
    // Older "anon" keys are JWTs and go in Authorization too; new publishable keys don't.
    if (/^eyJ/.test(cfg.supabaseKey || '')) h.Authorization = 'Bearer ' + cfg.supabaseKey;
    return h;
  }
  function rpc(fn, args) {
    if (!connected) return Promise.reject(new Error('not_connected'));
    return fetch(base + '/rest/v1/rpc/' + fn, {method: 'POST', headers: headers(), body: JSON.stringify(args), cache: 'no-store'})
      .then(function (r) { if (!r.ok) throw new Error('http_' + r.status); return r.json(); });
  }
  return {
    slug: slug,
    connected: connected,
    page: function () { return slug ? rpc('public_page', {p_slug: slug}) : Promise.resolve(null); },
    submit: function (kind, message, name, phone, ref) {
      return rpc('submit_inbox', {p_slug: slug, p_kind: kind, p_message: message, p_name: name || '', p_phone: phone || '', p_ref: ref || ''})
        .then(function (r) { if (!r || !r.ok) throw new Error((r && r.error) || 'failed'); return r; });
    },
    errorText: function (e) {
      var m = String(e && e.message || '');
      if (m === 'rate_limited') return 'Lots of messages have come in just now. Please send it on WhatsApp instead, or try again later.';
      if (m === 'page_off') return 'This page isn’t taking requests at the moment. Please message us instead.';
      if (m === 'not_found') return 'This booking page doesn’t exist any more.';
      if (m === 'invalid') return 'Something in the form isn’t right. Check it and try again.';
      return 'It didn’t send. Check your signal and try again, or send it on WhatsApp instead.';
    }
  };
})();
