# Checklister

A small installable checklist app (PWA). Plain HTML, CSS and JavaScript with no build step. Lists sync between devices through [Supabase](https://supabase.com).

## Setup

1. **Database:** in the Supabase SQL editor, run [`supabase-setup.sql`](supabase-setup.sql). It creates the `lists`, `list_members` and `list_invites` tables, the Row Level Security policies, the invite functions and live updates, and copies existing lists over from the older `checklists` table (which stays as a backup). **Run it before deploying a version of the app with sharing**, otherwise the app shows "Offline" and no lists. It's safe to run again. If an old-style `lists` table from an early app version is still there, the script renames it to `lists_legacy` and locks it (its data stays visible in the Table editor).
2. **Accounts (no public sign-up):** the app has no sign-up form. In Supabase → Authentication → Sign In / Providers, turn off **Allow new users to sign up**, otherwise anyone could still create an account through the API with the public key. Add users by hand under Authentication → Users → **Add user** → **Create new user**, with **Auto Confirm User** ticked.
3. **Password reset links:** in Supabase → Authentication → URL Configuration, add the app's address to **Redirect URLs** (for example `https://<user>.github.io/checklister/`), and `http://localhost:5173/` for local testing. Without this, reset emails link to the Site URL instead of the app.
4. **Hosting:** serve the folder as static files (GitHub Pages works as-is). No build step.
5. **Local development:** run any static server in the folder, for example `npx serve -l 5173`, and open `http://localhost:5173/`.

Supabase's built-in email sender only allows a few emails per hour. For real use, set up custom SMTP under Authentication → Emails.

To upgrade `supabase-js`, change the pinned version in both `index.html` and `sw.js`, and recompute the `integrity` hash (see `IMPROVEMENTS.md`, Phase B).

## Sharing a list

Tap 👥 on a list → **Create invite link**, and send the link to someone. When they open it and log in, the list appears in their app and you both see each other's changes live. The link works once and expires after 7 days. Since there's no sign-up, create an account for them first (setup step 2).

The 👥 sheet shows who has access. The owner can remove people. Everyone else can leave the list (the 🚪 button). Deleting a shared list removes it for everyone, after the usual Undo window.

## Shopping lists and task lists

When you create a list you pick its type. A **🛒 Shopping list** has prices, photos, a total and a history (below). A **✅ Task list** is a plain checklist: ticked items stay on the list below the done line until **Clear done** is pressed, and there are no prices, quantities or history. Tap the 🛒 / ✅ button next to the list name to change the type; nothing is lost, as a task list just hides its prices and history. Lists made before types existed are shopping lists.

## Prices, photos and history

Tap **kr** on an item to give it a price and a photo. They belong to the item's name on that list, so every "Milk" on the list shares them, and so does everyone the list is shared with. The list shows what's left to buy (price × quantity).

Ticking an item moves it to the list's **History**, grouped by day and month with a total for each. History keeps the price and quantity from when the item was ticked, and **Put back** returns it to the list.

Prices and history are saved in the list itself, but photos need the `product-photos` Storage bucket from part 3 of [`supabase-setup.sql`](supabase-setup.sql). Photos only load while online. Deleting a list doesn't delete its photos (Supabase → Storage shows them if you want to clean up).

An older version of the app (on a device that hasn't reloaded yet) still works with these lists. It doesn't show prices or history, and the database keeps them when it saves. Items it ticks off stay on the list as done, until **Move done to history** is pressed in the new version.

## About the Supabase key in `app.js`

`app.js` contains the Supabase project URL and a **publishable** key (`sb_publishable_…`). It's meant to be public:

- The app runs entirely in the browser, so every visitor's browser has to receive this key to talk to Supabase. Hiding it in an env file or a build secret wouldn't help, because it would still be visible in the deployed JavaScript.
- On its own the key can't access anyone's data. It only identifies the project.

**The data is protected by Row Level Security (RLS).** The policies in [`supabase-setup.sql`](supabase-setup.sql) only let a signed-in user read and change lists they're a member of. Only the owner can delete a list or remove people. A request with only the publishable key gets an empty result.

Never put a `service_role` or `sb_secret_…` key in this repo. Those bypass RLS and must stay on a server.
