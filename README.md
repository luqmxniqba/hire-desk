# Hire Desk: car hire tracker and booking pages

A live web app for small car hire firms, running on your own accounts, not inside Claude.

| Address | Who uses it | What it is |
|---|---|---|
| `/staff` | The business and its staff | The tracker: bookings, fleet, deposits, fines, customers, money. Sign-in required. |
| `/<page-address>` | Customers | The booking page: pick dates, see what's free and the price, send a request. |
| `/<page-address>/details` | Customers | The hire details form: address, licence, DVLA check code. |
| `/staff?demo` | Anyone | The tracker with example data, saved in that browser only. Good for showing other firms. |

Requests and forms from customers land on the tracker's **Today** page. Nobody has to copy and paste anything. WhatsApp still works as a backup.

One copy of the app serves many businesses. Each business only ever sees its own data. The database enforces that, not the app.

---

## Setting it up (about 20 minutes, easier on a laptop)

### 1. Supabase: the database and sign-in

1. Go to [supabase.com](https://supabase.com), sign up, and create a new project. Pick the **London** region. Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste in all of `supabase/schema.sql`, and press **Run**.
3. Still in the SQL editor, set the setup code people need to create a business on your platform. Make it long and random:
   ```sql
   update public.app_config set value = 'pick-a-long-random-code' where key = 'signup_code';
   ```
4. Copy the **Project URL** (on the project's home page under **Connect**, or **Project Settings → Data API**) and the **publishable key** (**Project Settings → API Keys**, or the legacy `anon` key). Both are safe to publish.
   **Never** use the `secret` or `service_role` key in the website. The build refuses to use one.

### 2. Vercel: the website

1. Push this folder to a GitHub repository (or let Claude do it once GitHub is connected).
2. On [vercel.com](https://vercel.com), choose **Add New → Project** and import the repository. Vercel reads `vercel.json`, so leave the build settings as they are.
3. `site/config.js` already points at your Supabase project, so this step is optional. To use a different project without editing the file, add these under **Environment Variables**:
   - `SUPABASE_URL`: your Project URL
   - `SUPABASE_KEY`: your publishable key
   - `PLATFORM_NAME` (optional): the name shown on the sign-in screen, e.g. `Hire Desk`
4. Press **Deploy**. You get an address like `https://your-app.vercel.app`.

### 3. Point Supabase sign-in at your site

In Supabase, go to **Authentication → URL Configuration**:
- **Site URL**: `https://your-app.vercel.app/staff`
- **Redirect URLs**: add `https://your-app.vercel.app/**`

### 4. Email: decide before inviting anyone

Supabase's built-in email **only sends to people on your own Supabase team**. Sign-up confirmations and password resets to your cousin or his staff won't arrive until you fix this. You have two options:

- **To go live today:** switch off **Authentication → Sign In / Providers → Email → Confirm email**. People can sign up straight away. Password reset emails still won't send, but anyone signed in can change their password from the account button.
- **Properly, within the first week:** buy a domain (about £10 a year) and connect a sending service such as Resend or Brevo under **Authentication → Emails → SMTP Settings**. Then switch **Confirm email** back on.

While confirmation is off, someone who knows a staff member's email could sign up with it before they do and take their invite. The risk is small for a small firm, but it's the reason to do the second option soon.

### 5. First run

1. Open `https://your-app.vercel.app/staff`, create your account, and open **Setting up a new business**. Enter the business name, the booking page address (e.g. `abc-car-hire`), and your setup code.
2. **Moving over from the Claude tracker:** open the old tracker, go to **Setup → Download a full backup**. In the new tracker, go to **Setup → Restore a backup**. Photos stored inside Claude don't come across; everything else does. After that, stop using the Claude version so the bookings don't split between two places.
3. In **Setup**, fill in the business name and phone, choose which cars show, and press **Switch it on** for the booking page. Do the same for the booking form.
4. Add a photo of each car: **Fleet → the car → Edit → Add a photo**. It replaces the drawing on the booking page. Shoot it side-on or from the front corner in daylight, with the plate out of shot or blurred. Photos are shrunk and the phone's location data is stripped before upload.
5. Add staff from the round account button, top right: **Add someone** with their email. They sign up at `/staff` with that email and they're in.
6. On a phone, open `/staff` and use **Add to Home Screen**. It opens like an app.

---

## Costs and the catches

- **Vercel's free plan is for non-commercial use only.** It's fine while you build and test. Move to the paid Pro plan once a business pays you.
- **Supabase's free plan pauses a project after a week with no activity**, and has no daily backups. Move to Pro (from $25 a month) before you rely on it for a paying client. One Pro project can hold many businesses.
- On paid plans the whole platform costs roughly £35–£50 a month at today's prices (Vercel Pro plus Supabase Pro), whether you have 1 business or 20. Check both pricing pages before you commit.
- If you use a custom domain for Supabase itself (not the website), add it to the `Content-Security-Policy` in `vercel.json`.

## Data protection (UK GDPR)

The tracker holds personal data: names, phone numbers, addresses, driving licence details and DVLA check codes. In practice:

- The **hire firm** is the data controller. **You**, as the platform, are their data processor. Put that in a short data processing agreement with each business.
- Most businesses that handle personal data must pay the **ICO data protection fee**. Check whether yours and theirs do at ico.org.uk.
- Each business needs a short **privacy notice** for customers explaining what it collects and why. Link it from the booking page intro or the business's socials.
- Only add people to a team who work in the business, and remove them when they leave (account button → Team → Remove).
- Never store card or bank details in the tracker.

## How it works

```
site/                    what Vercel serves
  staff/index.html       the tracker (built in Claude, ported to run here)
  staff/platform.js      sign-in, team, live sync, photo storage, downloads
  book/index.html        the customer booking page
  details/index.html     the customer hire details form
  shared/public.js       the two public calls the customer pages make
  config.js              Supabase address and publishable key (written at build time)
supabase/schema.sql      tables, security rules and functions (run once, safe to re-run)
vercel.json              page addresses and security headers
scripts/port.py          re-ports the tracker and booking page from the Claude versions
tests/                   database and browser tests (see tests/README.md)
```

- **Storage:** each record (car, booking, customer and so on) is one row in `records`, tagged with its business. Row-level security means a signed-in person can only read or change rows for a business whose team they're on.
- **Live updates:** open trackers hear about changes through Supabase Realtime, and also check every 30 seconds as a fallback.
- **Customer pages** never sign in. They can do exactly two things: read the availability the tracker publishes (no names, numbers or bookings), and send a request or form into that business's inbox. Both are limited to stop floods.
- **Photos** of damage, fines and documents go to a private storage bucket, in a folder per business, and are shown through links that expire. **Car photos for the booking page** go to a separate public bucket. Anyone can view them, but only that business's team can add or remove them.

## Not built yet

- **Reading chats and photos with AI** (Paste a chat, Snap a fine, Ask). These used Claude inside the artifact. They need an Anthropic API key behind a small server function. Until then the app says the feature isn't switched on, and everything else works without it.
- **Alerts when a request comes in** while nobody has the tracker open (email or WhatsApp).
- **Taking deposits online** (Stripe).
- **The general version for any type of business.** The sign-in, teams, security rules and inbox are already business-agnostic. The tracker screens are the car-hire-specific part.
