# Improvement plan

Findings from a review of the app (October 2026), grouped into phases.
Phases A and B are done; the rest are queued.

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

## Phase C: UX and accessibility

1. **Stop full re-renders**: every action rebuilds the whole card, so the card's pop-in and every row's slide-in animation replay on each checkbox tick. Text typed in "Add something…" is also wiped when another item is ticked.
   - Update only the affected row, badge and progress bar, or keep the add-input value and focus across renders.
   - Play the entry animations only on first display or for newly added rows.
2. **Accessibility**:
   - The checkbox `<input>` is `display:none`, so it can't be reached by keyboard. Hide it visually instead and show focus on `.cb-box`.
   - List tabs are `<div onclick>`. Make them `<button>`s with `aria-pressed` / `role="tab"`.
   - Add `aria-label` to the emoji-only buttons (🔒, 🗑, ✕, ＋, 👁) and to the item text inputs.
   - Remove `maximum-scale=1.0` from the viewport meta so pinch-zoom works.
   - Modal: `role="dialog"`, `aria-modal`, Escape to close, return focus on close.
3. **Undo instead of confirm**: deleting an item has no safety net, and deleting a list uses a native `confirm()`. Show a toast ("Item deleted · Undo") for a few seconds.
4. **Clearing an item's text**: the field goes blank but the saved data keeps the old text. Restore the old text on blur (or offer to delete the item).
5. **Code hygiene**: escape `'` in `escHtml`, and move from inline `onclick="fn('${id}')"` strings to event delegation with `data-` attributes.

## Phase D: New features

- Forgot password / reset via `supabase.auth.resetPasswordForEmail`.
- Reorder items (drag handle or long-press) and reorder lists.
- "Clear completed" action per list.
- Dark mode (`prefers-color-scheme`), reusing the existing CSS variables.
- Optional: live sync between open devices via Supabase Realtime on the `checklists` row.
- Housekeeping: README with setup steps, remove the empty `package-lock.json` (or add a real `package.json` with lint/format scripts), and use meaningful commit messages instead of "Update code".
