# Checklister

A small installable checklist app (PWA). Plain HTML, CSS and JavaScript with no build step. Lists sync between devices through [Supabase](https://supabase.com).

## About the Supabase key in `app.js`

`app.js` contains the Supabase project URL and a **publishable** key (`sb_publishable_…`). It's meant to be public:

- The app runs entirely in the browser, so every visitor's browser has to receive this key to talk to Supabase. Hiding it in an env file or a build secret wouldn't help, because it would still be visible in the deployed JavaScript.
- On its own the key can't access anyone's data. It only identifies the project.

**The data is protected by Row Level Security (RLS)** on the `checklists` table. The policies in [`supabase-setup.sql`](supabase-setup.sql) only let a signed-in user read and write their own row. A request with only the publishable key gets an empty result.

Never put a `service_role` or `sb_secret_…` key in this repo. Those bypass RLS and must stay on a server.
