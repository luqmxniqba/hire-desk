// Sign-up when Supabase asks people to confirm their email (the default).
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {startHarness} from './harness.mjs';

const H = await startHarness({port: 8091, db: 'hireconfirm', confirmEmail: true});
const B = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox']});
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('· ok', m); };
try {
  const p = await (await B.newContext()).newPage();
  await p.goto(H.origin + '/staff');
  await p.click('#pf-go-up');
  await p.fill('#pf-su [name=name]', 'Zara'); await p.fill('#pf-su [name=email]', 'zara@test.dev'); await p.fill('#pf-su [name=password]', 'zara-password-1');
  await p.click('#pf-su button[type=submit]');
  await p.waitForSelector('#pf-gate h1:has-text("Check your email")');
  ok(true, 'sign-up asks you to confirm your email');
  await p.click('#pf-go-in');
  await p.fill('#pf-si [name=password]', 'zara-password-1');
  await p.click('#pf-si button[type=submit]');
  await p.waitForSelector('#pf-gate h1:has-text("Check your email")');
  ok(true, 'signing in before confirming explains what to do');
  const link = await (await fetch(H.origin + '/__test/link?email=zara@test.dev')).json();
  const q = await (await B.newContext()).newPage();   // opened from the email, in a new tab
  await q.goto(link.url);
  await q.waitForSelector('#pf-gate h1:has-text("signed in")');
  ok((await q.textContent('.pf-ok')).includes('Email confirmed'), 'the email link confirms and signs you in');
  ok(!(await q.evaluate(() => location.hash)), 'address bar is clean after the link');
  const bad = await (await B.newContext()).newPage();
  await bad.goto(H.origin + '/staff#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await bad.waitForSelector('#pf-gate .pf-err');
  ok((await bad.textContent('#pf-gate .pf-err')).includes('expired'), 'an expired link gets a plain explanation');
} finally { await B.close(); await H.close(); }
console.log('Confirm-email checks passed:', n);
