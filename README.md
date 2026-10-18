# Checklister

A small installable checklist app (PWA). Plain HTML, CSS and JavaScript with no build step. Lists sync between devices through [Supabase](https://supabase.com).

## Setup

1. **Database:** in the Supabase SQL editor, run [`supabase-setup.sql`](supabase-setup.sql). It creates the `lists`, `list_members` and `list_invites` tables, the Row Level Security policies, the invite functions and live updates, and copies existing lists over from the older `checklists` table (which stays as a backup). **Run it before deploying a version of the app with sharing**, otherwise the app finds no lists. It's safe to run again.
2. **Accounts (no public sign-up):** the app has no sign-up form. In Supabase → Authentication → Sign In / Providers, turn off **Allow new users to sign up**, otherwise anyone could still create an account through the API with the public key. Add users by hand under Authentication → Users → **Add user** → **Create new user**, with **Auto Confirm User** ticked.
3. **Password reset links:** in Supabase → Authentication → URL Configuration, add the app's address to **Redirect URLs** (for example `https://<user>.github.io/checklister/`), and `http://localhost:5173/` for local testing. Without this, reset emails link to the Site URL instead of the app.
4. **Hosting:** serve the folder as static files (GitHub Pages works as-is). No build step.
5. **Local development:** run any static server in the folder, for example `npx serve -l 5173`, and open `http://localhost:5173/`.

Supabase's built-in email sender only allows a few emails per hour. For real use, set up custom SMTP under Authentication → Emails.

To upgrade `supabase-js`, change the pinned version in both `index.html` and `sw.js`, and recompute the `integrity` hash (see `IMPROVEMENTS.md`, Phase B).

## Sharing a list

Tap 👥 on a list → **Create invite link**, and send the link to someone. When they open it and log in, the list appears in their app and you both see each other's changes live. The link works once and expires after 7 days. Since there's no sign-up, create an account for them first (setup step 2).

The 👥 sheet shows who has access. The owner can remove people. Everyone else can leave the list (the 🚪 button). Deleting a shared list removes it for everyone, after the usual Undo window.

## About the Supabase key in `app.js`

`app.js` contains the Supabase project URL and a **publishable** key (`sb_publishable_…`). It's meant to be public:

- The app runs entirely in the browser, so every visitor's browser has to receive this key to talk to Supabase. Hiding it in an env file or a build secret wouldn't help, because it would still be visible in the deployed JavaScript.
- On its own the key can't access anyone's data. It only identifies the project.

**The data is protected by Row Level Security (RLS).** The policies in [`supabase-setup.sql`](supabase-setup.sql) only let a signed-in user read and change lists they're a member of. Only the owner can delete a list or remove people. A request with only the publishable key gets an empty result.

Never put a `service_role` or `sb_secret_…` key in this repo. Those bypass RLS and must stay on a server.
