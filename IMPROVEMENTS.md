# Improvement plan

Findings from a review of the app (October 2026), grouped into phases.
All four phases are done; a few optional items remain at the end of Phase D.

## ✅ Phase A: Data safety (done, branch `data-safety`)

- A stale or empty local copy can no longer overwrite the cloud: nothing is pushed until this session has loaded the cloud version.
- Saves use optimistic locking on `updated_at`. If another device saved first, the two versions are three-way merged and the save is retried.
- Every edit is written to localStorage first (with a "dirty" flag), so edits survive a closed tab, a failed save or a logout while offline.
- Edits are pushed immediately when the app is backgrounded. Changes from other devices are pulled when the app returns to the foreground or comes back online.
- Failed syncs retry with backoff (2 s → 60 s), and every request has a 15 s timeout.
- Corrupt localStorage no longer prevents the app from starting.
- The app shows this device's copy immediately on start, and an "Offline" label when it can't reach the cloud.
- `supabase-setup.sql` documents the schema, the one-row-per-user constraint and the RLS policies.

Known limits:
- A delete only "sticks" in a merge if the other device didn't edit the same item.
- Two tabs on the same device share one localStorage copy. Each tab's cloud writes are still conflict-checked.

## ✅ Phase B: PWA and updates (done, branch `data-safety`)

- `sw.js` is now network-first for app files (HTML, JS, CSS, manifest), with a cache fallback when offline or when the network takes longer than 4 s. New deploys show up on the next load, and `CACHE` only needs a bump when the precache list changes.
- Pinned CDN files and font files are cache-first. Images and the Google Fonts stylesheet are served from cache and refreshed in the background. Supabase API calls and non-GET requests are never intercepted.
- Each precache file is cached on its own, so one failure no longer breaks the whole offline copy. Font `woff2` files are cached at runtime, and `./` is precached alongside `./index.html`.
- The service worker is registered at page load, so the login screen works offline too.
- `supabase-js` is pinned to `2.117.2` with an SRI hash. To upgrade, change the version in `index.html` and `sw.js`, and recompute the hash:
  `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`
- Skipped: the "update available" toast. With network-first loading the app is already current on every load, so it isn't needed.

## ✅ Phase C: UX and accessibility (done, branch `data-safety`)

- **No more full redraws on a tick:** ticking a checkbox updates only that row, the progress bar and the subtitle. The checkbox and progress bar now actually animate.
- Other redraws keep the focused field, its half-typed text and the cursor position (also when another device's changes arrive).
- Each list keeps its own unsent "Add something…" text.
- Entry animations play only when a list is first shown or an item was just added.
- **Keyboard and screen readers:**
  - The checkbox is visually hidden but still focusable, with a visible focus ring.
  - List tabs are `<button aria-pressed>`.
  - Every icon-only button and input has an `aria-label`.
  - The "Offline" label and the toast are announced (`aria-live`).
  - The "New List" sheet is a proper dialog: Escape closes it, Tab stays inside it, and focus returns to where it came from.
- **Zoom:** `maximum-scale=1.0` is removed so pinch-zoom works. Text inputs are now 16px so iOS doesn't auto-zoom when one is focused.
- **Undo instead of confirm:** deleting an item or a list shows a 6 s "Deleted … · Undo" toast that puts it back in the same place. The native `confirm()` on list delete is gone.
- **Blank text:** clearing an item's text or a list's name puts the saved text back on blur. Escape throws away an edit. Leaving a field unchanged no longer triggers a save.
- **Code hygiene:** the generated HTML has no inline `onclick="fn('${id}')"` handlers any more. One delegated listener per container reads `data-list` / `data-item`, and `escHtml` also escapes `'`.

## ✅ Phase D: New features (done, branch `data-safety`)

- **Forgot password:** a "Forgot password?" link on the login screen emails a reset link (`resetPasswordForEmail`, redirecting back to the app). Opening the link signs the user in and shows a "Choose a new password" sheet (`updateUser`). An expired link shows a clear error on the login screen. The success message is the same whether or not the account exists.
  - Needs the app's URL in Supabase → Authentication → URL Configuration → Redirect URLs (see README).
- **Clear done:** a "Clear done" button on the progress row removes all ticked items. Undo puts them back in place and keeps anything added since.
- **Dark mode:** follows the device setting (`prefers-color-scheme`). Every hard-coded colour is now a CSS variable, with warm dark counterparts for the mint, coral and sand palette. The browser bar colour (`theme-color`) matches the scheme.
- **Reorder items:**
  - Drag the ⋮⋮ handle; the page auto-scrolls near the screen edges.
  - With the handle focused, the up and down arrow keys move the item. Screen readers hear the new position.
- **Shared sheets:** "New List" and "Choose a new password" use the same dialog behaviour (Escape, Tab trap, focus return).
- README now has setup steps.
- **Sign-up removed:** the login screen has no sign-up tab any more. Accounts are created by hand in the Supabase dashboard, with public sign-ups switched off there (see README).

Not done (still open):
- Reordering lists (tabs). The horizontal tab strip scrolls, so dragging there needs a different gesture.
- A manual light/dark switch (dark mode only follows the device for now).
- Live sync between open devices via Supabase Realtime. It needs Realtime turned on for `checklists` in the dashboard; the app would then call `sync({ pull: true })` on each change.
- The empty, untracked `package-lock.json`: delete it, or add a real `package.json` with lint/format scripts.

Known limit: if two devices reorder the same list at the same time, the order from whichever saved first is kept. Items are never lost, only that device's ordering.
