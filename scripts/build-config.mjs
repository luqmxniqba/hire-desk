// Runs on Vercel when the site is built. If SUPABASE_URL and SUPABASE_KEY are set in the
// project's Environment Variables, it writes them into site/config.js. If not, the
// committed config.js is used as it is.
import fs from 'node:fs';

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_KEY || '').trim();
const name = (process.env.PLATFORM_NAME || '').trim();
if (!url || !key) {
  console.log('SUPABASE_URL / SUPABASE_KEY not set: using site/config.js as committed.');
  process.exit(0);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) console.warn('Warning: SUPABASE_URL is not a *.supabase.co address. Update the Content-Security-Policy in vercel.json to allow it.');
let role = '';
try { if (key.startsWith('eyJ')) role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role || ''; } catch (e) { /* not a JWT */ }
if (key.startsWith('sb_secret_') || role === 'service_role') {
  console.error('SUPABASE_KEY is a SECRET key. Never put it in the website: use the publishable (or anon) key. Stopping.');
  process.exit(1);
}
const cfg = {supabaseUrl: url.replace(/\/+$/, ''), supabaseKey: key, platformName: name || 'Hire Desk'};
fs.writeFileSync(new URL('../site/config.js', import.meta.url), '// Written at build time from Vercel environment variables.\nwindow.APP_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n');
console.log('Wrote site/config.js for', cfg.supabaseUrl);
