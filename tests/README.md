# Tests

These run the real database rules and the real pages in Chrome, against a local Postgres with a
small stand-in for Supabase's API (`harness.mjs`). Nothing here touches a real Supabase project.

```bash
# a throwaway local Postgres 16 on port 54322 (run as the postgres user)
initdb -D /tmp/pg/data -U postgres --auth=trust
pg_ctl -D /tmp/pg/data -o "-p 54322 -c wal_level=logical -k /tmp/pg" -l /tmp/pg/pg.log start

npm install
npm test          # SQL security rules, the full end-to-end journey, and email-confirmation sign-up
```

The browser tests use Chrome at `/usr/bin/google-chrome`. Screenshots land in `tests/shots/`.

What's covered:
- `sql.test.mjs`: 68 checks on the security rules: who can read and change what, team invites, the
  customer functions and their limits, photo storage.
- `e2e.test.mjs`: 30 checks across the whole journey: demo backup, sign-up, setting up a business,
  restoring a backup, switching the booking page on, a customer request and hire details form
  from a phone, the inbox, opening a request as a booking, photos, adding staff, two phones in
  sync, an outsider kept out, password reset, sign out and in.
- `confirm.test.mjs`: sign-up when email confirmation is switched on, and expired links.

Not covered here: Supabase Realtime (the app falls back to checking every 30 seconds, which is
what these tests exercise) and real email delivery.
