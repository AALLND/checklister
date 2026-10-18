# Checklister

A small installable checklist app (PWA). Plain HTML, CSS and JavaScript with no build step. Lists sync between devices through [Supabase](https://supabase.com).

## Setup

1. **Database:** in the Supabase SQL editor, run [`supabase-setup.sql`](supabase-setup.sql). It creates the `checklists` table, the one-row-per-user constraint and the Row Level Security policies.
2. **Accounts (no public sign-up):** the app has no sign-up form. In Supabase → Authentication → Sign In / Providers, turn off **Allow new users to sign up**, otherwise anyone could still create an account through the API with the public key. Add users by hand under Authentication → Users → **Add user** → **Create new user**, with **Auto Confirm User** ticked.
3. **Password reset links:** in Supabase → Authentication → URL Configuration, add the app's address to **Redirect URLs** (for example `https://<user>.github.io/checklister/`), and `http://localhost:5173/` for local testing. Without this, reset emails link to the Site URL instead of the app.
4. **Hosting:** serve the folder as static files (GitHub Pages works as-is). No build step.
5. **Local development:** run any static server in the folder, for example `npx serve -l 5173`, and open `http://localhost:5173/`.

Supabase's built-in email sender only allows a few emails per hour. For real use, set up custom SMTP under Authentication → Emails.

To upgrade `supabase-js`, change the pinned version in both `index.html` and `sw.js`, and recompute the `integrity` hash (see `IMPROVEMENTS.md`, Phase B).

## About the Supabase key in `app.js`

`app.js` contains the Supabase project URL and a **publishable** key (`sb_publishable_…`). It's meant to be public:

- The app runs entirely in the browser, so every visitor's browser has to receive this key to talk to Supabase. Hiding it in an env file or a build secret wouldn't help, because it would still be visible in the deployed JavaScript.
- On its own the key can't access anyone's data. It only identifies the project.

**The data is protected by Row Level Security (RLS)** on the `checklists` table. The policies in [`supabase-setup.sql`](supabase-setup.sql) only let a signed-in user read and write their own row. A request with only the publishable key gets an empty result.

Never put a `service_role` or `sb_secret_…` key in this repo. Those bypass RLS and must stay on a server.
