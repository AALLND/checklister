// ─── CONFIG ───────────────────────────────────────────────────────────
// This key is MEANT to be public — it's fine that it's visible on GitHub.
// Real access control lives in Supabase's Row Level Security policies
// (see supabase-setup.sql), not in hiding this key.
const SUPABASE_URL = 'https://bjdhtxtwreklnnseodjb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Ah_nnrgqnY5dVFJmpEtnZA_YawMCkzD';
// ──────────────────────────────────────────────────────────────────────

// Requests that hang (flaky mobile network) would otherwise leave the app
// "syncing" forever and never retry, so every request gets a timeout.
function fetchWithTimeout(url, opts = {}) {
  if (opts.signal) return fetch(url, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Read before supabase-js consumes the URL: a password-reset email links
// back here with "type=recovery" in the hash, or an error if it expired.
const authRedirect = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));

// An invite link (?invite=…) is remembered until the user has logged in.
(function rememberInvite() {
  const code = new URLSearchParams(location.search).get('invite');
  if (!code) return;
  try { sessionStorage.setItem('checklister_invite', code); } catch (e) {}
  history.replaceState(null, '', location.pathname + location.hash);
})();

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: { fetch: fetchWithTimeout }
});

let lists = [];
let activeId = null;
let appInited = false;
let currentUser = null;

// Sync state, per list. meta[id] = { base, at }: `base` is the last version
// of that list we know is in the cloud and `at` its row's `updated_at`. A
// list that differs from its base (or has none yet) has edits to upload.
// `removals` holds lists deleted or left on this device, done in the cloud
// once their Undo window has passed. `shareInfo` comes from the last pull.
let meta = {};
let removals = {};          // id → { leave, at }
let shareInfo = {};         // id → { mine, members }
let cloudChecked = false;   // loaded from the cloud at least once this session
let lastPull = 0;
let saveTimer = null;
let retryTimer = null;
let removalTimer = null;
let retryDelay = 2000;
let syncChain = Promise.resolve();
let syncQueued = null;      // options for the run waiting in syncChain, if any
let realtimeChannel = null;
let realtimeTimer = null;
const UNDO_MS = 6500;       // a little longer than the Undo toast is shown

// ─── AUTH UI ──────────────────────────────────────────────────────────
// Log in only: there is no sign-up in the app. Accounts are added by hand in
// the Supabase dashboard, and public sign-ups are switched off there (see
// README), since hiding the form alone wouldn't stop the API from creating them.
function hideAuthMessages() {
  document.getElementById('authError').classList.remove('show');
  document.getElementById('authSuccess').classList.remove('show');
}

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = '❌ ' + msg;
  el.classList.add('show');
  document.getElementById('authSuccess').classList.remove('show');
}

function showAuthSuccess(msg) {
  const el = document.getElementById('authSuccess');
  el.textContent = '✅ ' + msg;
  el.classList.add('show');
  document.getElementById('authError').classList.remove('show');
}

async function submitAuth() {
  hideAuthMessages();
  const email = document.getElementById('emailInput').value.trim();
  const pw = document.getElementById('pwInput').value;
  const btn = document.getElementById('authBtn');

  if (!email || !pw) { showAuthError('Enter an email and password'); return; }
  if (pw.length < 6) { showAuthError('Password must be at least 6 characters'); return; }

  btn.disabled = true;
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: pw });
    if (error) throw error;
    onLoggedIn(data.user);
  } catch (e) {
    showAuthError(e.message || 'Something went wrong');
  } finally {
    btn.disabled = false;
  }
}

function togglePwVisibility() {
  const inp = document.getElementById('pwInput');
  const btn = document.getElementById('togglePwBtn');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
  btn.setAttribute('aria-pressed', String(show));
}

async function logOut() {
  // Push pending edits first so they aren't stranded on this device.
  clearTimeout(saveTimer);
  Object.values(removals).forEach(r => { r.at = 0; }); // Undo is gone once we log out
  if (hasPending()) await sync();
  if (hasPending() && !confirm('Some changes haven\'t reached the cloud yet. They stay saved on this device and sync the next time you log in here.\n\nLog out anyway?')) return;
  await supabaseClient.auth.signOut();
  // onAuthStateChange also fires SIGNED_OUT; resetting twice is harmless.
  resetToLoginScreen();
}

// Every way a session can end (logout, expired token, logout in another tab)
// goes through here, so the app never stays on screen without a user.
function resetToLoginScreen() {
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  clearTimeout(removalTimer);
  stopRealtime();
  currentUser = null;
  lists = [];
  activeId = null;
  meta = {};
  removals = {};
  shareInfo = {};
  cloudChecked = false;
  retryDelay = 2000;
  appInited = false;
  renderedListId = null;
  justAddedId = null;
  addDrafts = {};
  hideToast();
  closeModal();
  closeSheet('pwOverlay');
  closeSheet('shareOverlay');
  setSyncState('ok');
  document.getElementById('appWrapper').style.display = 'none';
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('emailInput').value = '';
  document.getElementById('pwInput').value = '';
  hideAuthMessages();
}

function onLoggedIn(user) {
  currentUser = user;
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appWrapper').style.display = 'block';
  initApp();
}

// ─── APP INIT ─────────────────────────────────────────────────────────
function initApp() {
  if (appInited) return;
  appInited = true;
  const user = currentUser;
  // Show this device's copy right away; the cloud version is merged in
  // when it arrives (see pullFromCloud).
  loadLocal();
  if (lists.length) {
    render();
  } else {
    document.getElementById('mainContent').innerHTML = `<div class="loading-screen">
      <div class="loading-spinner"></div>
      <p>Loading your lists…</p>
    </div>`;
  }
  // pullFromCloud renders when the lists change; this covers the cases where
  // nothing changed but the spinner still needs replacing.
  sync().then(() => {
    if (currentUser !== user) return;
    if (document.querySelector('#mainContent .loading-screen')) render();
    startRealtime();
    acceptPendingInvite();
  });
}

// ─── SYNC ─────────────────────────────────────────────────────────────
// Each list is its own row in the `lists` table, shared by its members
// (see supabase-setup.sql). Rules, per list:
//  • Every edit is written to localStorage first, then uploaded.
//  • Nothing is uploaded until this session has loaded the cloud versions,
//    so a stale local copy can never overwrite newer data.
//  • An upload only overwrites the exact version it was based on. If
//    someone else saved in between, the two versions are merged and the
//    upload is retried.
//  • Deleting or leaving a list waits out the Undo window before it's done
//    in the cloud, so Undo never loses the list's members.
//  • Failed syncs retry with backoff, and when the device comes back online.
function isDirty(list) {
  const m = meta[list.id];
  return !m || !m.at || !same(list, m.base);
}

function hasPending() {
  return lists.some(isDirty) || Object.keys(removals).length > 0;
}

function setSyncState(state) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if (!dot) return;
  dot.className = 'sync-dot' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
  dot.title = state === 'ok' ? 'Saved to cloud ✓'
    : state === 'syncing' ? 'Syncing…'
    : hasPending() ? 'Offline – changes are saved on this device and will sync later'
    : 'Can\'t reach the cloud – retrying';
  if (label) label.textContent = state === 'error' ? 'Offline' : '';
}

function localKey() { return 'checklister_' + currentUser.id; }

function saveLocal() {
  try {
    localStorage.setItem(localKey(), JSON.stringify({ v: 3, lists, meta, removals, shareInfo }));
  } catch (e) {
    console.warn('Could not save to localStorage:', e);
  }
}

function loadLocal() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(localKey())); }
  catch (e) { console.warn('Ignoring unreadable local data:', e); }
  if (Array.isArray(stored)) stored = { lists: stored }; // pre-v2 format: just the lists
  stored = stored || {};
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  meta = {}; removals = {}; shareInfo = {};
  if (stored.v === 3) {
    lists = Array.isArray(stored.lists) ? stored.lists : [];
    meta = obj(stored.meta);
    removals = obj(stored.removals);
    shareInfo = obj(stored.shareInfo);
  } else if (stored.dirty && Array.isArray(stored.lists)) {
    // Old single-row format with edits that never reached the cloud: keep
    // them, and merge them into the cloud lists on the first sync.
    lists = stored.lists;
    const oldBase = Array.isArray(stored.base) ? stored.base : [];
    lists.forEach(l => { meta[l.id] = { base: oldBase.find(b => b.id === l.id) || null, at: null }; });
  } else {
    lists = []; // old format without pending edits: the cloud has it all
  }
  fixActiveId();
}

// Called after every local edit.
function scheduleSave() {
  saveLocal();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => sync(), 600);
}

// Runs one sync at a time. Calls made while a run is waiting to start are
// folded into it; the returned promise settles after a run that started
// after the call, and never rejects.
function sync(opts = {}) {
  if (syncQueued) {
    syncQueued.pull = syncQueued.pull || !!opts.pull;
    return syncChain;
  }
  syncQueued = { pull: !!opts.pull };
  syncChain = syncChain.then(() => {
    const run = syncQueued;
    syncQueued = null;
    return runSync(run);
  });
  return syncChain;
}

async function runSync({ pull }) {
  const user = currentUser;
  if (!user) return;
  clearTimeout(retryTimer);
  setSyncState('syncing');
  try {
    if (!cloudChecked || pull) await pullFromCloud(user);
    if (hasPending()) await pushToCloud(user);
    retryDelay = 2000;
    setSyncState('ok');
    scheduleRemovals();
  } catch (e) {
    if (currentUser !== user) return; // logged out mid-sync
    console.warn('Sync failed:', e);
    setSyncState('error');
    if (hasPending() || !cloudChecked) {
      retryTimer = setTimeout(() => sync(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    }
  }
}

// Deletes still inside their Undo window: sync again once it has passed.
function scheduleRemovals() {
  clearTimeout(removalTimer);
  const waits = Object.values(removals).map(r => r.at + UNDO_MS - Date.now());
  if (waits.length) removalTimer = setTimeout(() => sync(), Math.max(0, Math.min(...waits)) + 50);
}

function checkSameUser(user) {
  if (currentUser !== user) throw new Error('Session changed during sync');
}

function rowToList(row) {
  const d = row.data || {};
  return { id: row.id, name: typeof d.name === 'string' ? d.name : 'List', items: Array.isArray(d.items) ? d.items : [] };
}

async function pullFromCloud(user) {
  const { data, error } = await supabaseClient
    .from('lists')
    .select('id, data, updated_at, owner_id, list_members(user_id)')
    .order('created_at');
  checkSameUser(user);
  if (error) throw error;

  lastPull = Date.now();
  const before = stableStr(lists) + stableStr(shareInfo);
  const remote = new Map(data.map(row => [row.id, row]));
  const gone = [];
  const next = [];
  lists.forEach(l => {
    const m = meta[l.id];
    const row = remote.get(l.id);
    if (!row) {
      // It was in the cloud and now isn't: the owner deleted it, or we were
      // removed from it. Never uploaded yet: it's new, keep it.
      if (m && m.at) { delete meta[l.id]; gone.push(l.name); return; }
      next.push(l);
      return;
    }
    if (m && row.updated_at === m.at) { next.push(l); return; }
    const r = rowToList(row);
    // Copies, so editing the list can never change its base by accident.
    next.push(clone(isDirty(l) ? mergeLists(m && m.base ? [m.base] : [], [l], [r])[0] : r));
    meta[l.id] = { base: r, at: row.updated_at };
  });
  data.forEach(row => {
    // New on another device, or just shared with us.
    if (removals[row.id] || next.some(l => l.id === row.id)) return;
    const r = rowToList(row);
    next.push(clone(r));
    meta[row.id] = { base: r, at: row.updated_at };
  });
  shareInfo = {};
  data.forEach(row => {
    shareInfo[row.id] = { mine: row.owner_id === user.id, members: (row.list_members || []).length || 1 };
  });

  lists = next;
  cloudChecked = true;
  saveLocal();
  if (stableStr(lists) + stableStr(shareInfo) !== before) { fixActiveId(); render(); }
  if (gone.length) showToast(`“${shorten(gone[0])}”${gone.length > 1 ? ` and ${gone.length - 1} more` : ''} was deleted or is no longer shared with you`);
}

async function pushToCloud(user) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let conflict = false;
    for (const list of lists.filter(isDirty)) {
      const snap = clone(list);
      const data = { name: snap.name, items: snap.items };
      const m = meta[snap.id];
      const now = new Date().toISOString();
      const res = !(m && m.at)
        ? await supabaseClient
            .from('lists')
            .insert({ id: snap.id, data, updated_at: now })
            .select('updated_at')
        // Only overwrite the version we started from. If someone else saved
        // in the meantime, nothing matches and we merge instead.
        : await supabaseClient
            .from('lists')
            .update({ data, updated_at: now })
            .eq('id', snap.id)
            .eq('updated_at', m.at)
            .select('updated_at');
      checkSameUser(user);
      if (res.error && res.error.code !== '23505') throw res.error; // 23505: already exists
      if (res.error || !res.data || !res.data.length) { conflict = true; continue; }
      meta[snap.id] = { base: snap, at: res.data[0].updated_at };
      saveLocal();
    }
    await applyRemovals(user);
    if (!conflict) return;
    await pullFromCloud(user); // merges the other version in, then try again
  }
  throw new Error('Lists kept changing during save');
}

async function applyRemovals(user) {
  for (const [id, r] of Object.entries(removals)) {
    if (Date.now() - r.at < UNDO_MS) continue;
    const res = r.leave
      ? await supabaseClient.from('list_members').delete().eq('list_id', id).eq('user_id', user.id)
      : await supabaseClient.from('lists').delete().eq('id', id);
    checkSameUser(user);
    if (res.error) throw res.error;
    delete removals[id];
    delete meta[id];
    delete shareInfo[id];
    saveLocal();
  }
}

// Live updates: when a list we can see (or its members) changes in the
// cloud, pull. Events we already know about are skipped: the echo of our own
// save, and deletes of lists we don't have (Supabase sends every client all
// delete events, see IMPROVEMENTS.md). Events are checked when the short
// wait is over, so an echo that beats our save's own response is still
// recognised.
let realtimePending = [];

function isKnownChange(p) {
  if (p.table !== 'lists') return false; // member changes always pull
  if (p.eventType === 'DELETE') {
    const id = p.old && p.old.id;
    return !!id && !findList(id) && !meta[id];
  }
  const row = p.new;
  return !!row && !!meta[row.id] && sameTime(meta[row.id].at, row.updated_at);
}

// Realtime and the REST API may format the same timestamptz differently.
function sameTime(a, b) {
  return a === b || (!!a && !!b && Date.parse(a) === Date.parse(b));
}

function startRealtime() {
  stopRealtime();
  const user = currentUser;
  const onChange = payload => {
    realtimePending.push(payload);
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(() => {
      const events = realtimePending;
      realtimePending = [];
      if (currentUser !== user) return;
      // The save that caused an echo may still be in flight: check once it's done.
      syncChain.then(() => {
        if (currentUser === user && !events.every(isKnownChange)) sync({ pull: true });
      });
    }, 400);
  };
  try {
    realtimeChannel = supabaseClient
      .channel('lists-' + user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lists' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'list_members' }, onChange)
      .subscribe();
  } catch (e) {
    console.warn('Live updates unavailable:', e);
  }
}

function stopRealtime() {
  clearTimeout(realtimeTimer);
  realtimePending = [];
  if (!realtimeChannel) return;
  try { supabaseClient.removeChannel(realtimeChannel); } catch (e) {}
  realtimeChannel = null;
}

// Three-way merge of list sets. `base` is the cloud version both sides
// started from: whatever changed on only one side wins, and if both sides
// changed the same item, the local edit wins. Anything created or edited on
// either side is kept; a delete only sticks if the other side didn't edit it.
function mergeLists(base, local, remote) {
  return mergeById(base, local, remote, (b, l, r) => ({
    ...r,
    name: b && b.name === l.name ? r.name : l.name,
    items: mergeById(b ? b.items : [], l.items, r.items, (bi, li, ri) => bi && same(bi, li) ? ri : li)
  }));
}

function mergeById(base, local, remote, mergeBoth) {
  const byId = arr => new Map(arr.map(x => [x.id, x]));
  const B = byId(base), L = byId(local), R = byId(remote);
  const out = [];
  remote.forEach(r => {
    const b = B.get(r.id), l = L.get(r.id);
    if (l) out.push(mergeBoth(b, l, r));
    else if (!b || !same(b, r)) out.push(r); // new remotely, or deleted here but edited there
  });
  local.forEach(l => {
    const b = B.get(l.id);
    if (!R.has(l.id) && (!b || !same(b, l))) out.push(l); // new here, or deleted there but edited here
  });
  return out;
}

// JSON with sorted keys: Postgres jsonb doesn't preserve key order.
function stableStr(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function same(a, b) { return stableStr(a) === stableStr(b); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

function fixActiveId() {
  if (!lists.some(l => l.id === activeId)) activeId = lists[0]?.id || null;
}

// ─── UTILS ────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,5); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function shorten(s, n = 30) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function findList(id) { return lists.find(l => l.id === id); }
function findItem(listId, itemId) { return findList(listId)?.items.find(i => i.id === itemId); }
function listStats(list) {
  const total = list.items.length;
  const done = list.items.filter(i => i.done).length;
  return { total, done, pct: total ? Math.round(done / total * 100) : 0, allDone: total > 0 && done === total };
}

// ─── RENDER ───────────────────────────────────────────────────────────
// render() rebuilds the tabs and the card from `lists`. Entry animations
// only play when a list is first shown or an item was just added, and the
// focused field (with any half-typed text) survives the rebuild. Ticking a
// checkbox doesn't rebuild anything; see toggleItem().
let renderedListId = null; // list whose card is on screen
let justAddedId = null;    // item to animate in on the next render
let addDrafts = {};        // unsent "Add something…" text, per list

function render() {
  if (drag) finishDrag(false); // e.g. another device's changes arrived mid-drag
  const focus = captureFocus();
  renderTabs();
  renderContent();
  updateSubtitle();
  restoreFocus(focus);
}

function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.dataset || !el.dataset.focusKey) return null;
  return { key: el.dataset.focusKey, tag: el.tagName, value: el.value, start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(f) {
  if (!f) return;
  const el = document.querySelector(`[data-focus-key="${CSS.escape(f.key)}"]`);
  if (!el) return;
  if (f.tag === 'INPUT' && el.type === 'text') el.value = f.value;
  el.focus();
  if (f.start != null) { try { el.setSelectionRange(f.start, f.end); } catch (e) {} }
}

function updateSubtitle() {
  const sub = document.getElementById('subtitle');
  if (!sub) return;
  if (!lists.length) { sub.textContent = 'Start by creating a list 💫'; return; }
  const total = lists.reduce((a,l) => a + l.items.length, 0);
  const done  = lists.reduce((a,l) => a + l.items.filter(i=>i.done).length, 0);
  sub.textContent = total ? `${done} of ${total} done ${done===total && total>0 ? '🎉':''}`.trim() : 'Add some items!';
}

function updateProgress(list) {
  const { done, pct, allDone } = listStats(list);
  const fill = document.querySelector('.progress-fill');
  if (fill) { fill.style.width = pct + '%'; fill.classList.toggle('full', allDone); }
  const label = document.querySelector('.progress-label');
  if (label) label.textContent = pct + '%';
  document.querySelector('.all-done-banner')?.classList.toggle('show', allDone);
  const clear = document.querySelector('.clear-done-btn');
  if (clear) clear.hidden = !done;
}

function renderTabs() {
  const el = document.getElementById('listTabs');
  if (!el) return;
  el.innerHTML = lists.map(l => {
    const active = l.id === activeId;
    const id = escHtml(l.id);
    return `<button class="tab${active ? ' active' : ''}" data-action="switch-list" data-list="${id}"
      data-focus-key="tab:${id}" aria-pressed="${active}">
      ${escHtml(l.name)}
      ${shareInfo[l.id]?.members > 1 ? '<span class="tab-shared" aria-hidden="true">👥</span><span class="sr-only">(shared)</span>' : ''}
      <span class="tab-badge">${l.items.length}</span>
    </button>`;
  }).join('') + `<button class="new-tab-btn" data-action="new-list">＋ New List</button>`;
}

function renderContent() {
  const el = document.getElementById('mainContent');
  if (!el) return;
  const list = findList(activeId);

  if (!list) {
    renderedListId = null;
    el.innerHTML = cloudChecked
      ? `<div class="no-lists">
          <div class="nl-icon">🌸</div>
          <h2>No lists yet!</h2>
          <p>Tap <strong>＋ New List</strong> above<br>to create your first checklist~</p>
        </div>`
      : `<div class="no-lists">
          <div class="nl-icon">☁️</div>
          <h2>Can't reach the cloud</h2>
          <p>Your lists will show up as soon<br>as you're back online.</p>
          <button class="retry-btn" data-action="retry">Try again</button>
        </div>`;
    return;
  }

  el.innerHTML = getListHTML(list);
  renderedListId = list.id;
  justAddedId = null;
}

function getListHTML(list) {
  const { total, done, pct, allDone } = listStats(list);
  const info = shareInfo[list.id];
  const shared = info?.members > 1;
  const leave = info?.mine === false;
  const isNewCard = list.id !== renderedListId;
  const lid = escHtml(list.id);

  const itemsHtml = list.items.length ? list.items.map(item => {
    const iid = escHtml(item.id);
    const animate = isNewCard || item.id === justAddedId;
    return `<li class="item-row${animate ? ' slide-in' : ''}" data-item="${iid}">
      <button class="drag-handle" data-focus-key="drag:${iid}" title="Drag to reorder"
        aria-label="Reorder ${escHtml(item.text)}. Use the up and down arrow keys.">⋮⋮</button>
      <label class="cb-wrap">
        <input type="checkbox" data-action="toggle" data-focus-key="cb:${iid}" aria-label="${escHtml(item.text)}" ${item.done ? 'checked' : ''}>
        <div class="cb-box" aria-hidden="true"><span class="tick">✓</span></div>
      </label>
      <div class="item-text-wrap">
        <input class="item-text${item.done ? ' done' : ''}" type="text" value="${escHtml(item.text)}"
          data-field="item" data-focus-key="item:${iid}" aria-label="Item text">
      </div>
      <button class="item-del" data-action="delete-item" data-focus-key="del:${iid}" aria-label="Delete item">✕</button>
    </li>`;
  }).join('') : `<li class="empty-state">
      <div class="e-icon">🌸</div>
      <p>Nothing here yet~<br>Add your first item below!</p>
    </li>`;

  return `<div class="list-card${isNewCard ? ' pop-in' : ''}" data-list="${lid}">
    <div class="card-header">
      <input class="card-title-input" type="text" value="${escHtml(list.name)}"
        data-field="title" data-focus-key="title:${lid}" aria-label="List name">
      <button class="share-btn${shared ? ' is-shared' : ''}" data-action="share-list" title="Share list"
        aria-label="${shared ? `Shared with ${info.members - 1} other${info.members > 2 ? 's' : ''}. Share list` : 'Share list'}">👥${shared ? `<span class="share-count">${info.members}</span>` : ''}</button>
      <button class="del-list-btn" data-action="delete-list" title="${leave ? 'Leave list' : 'Delete list'}" aria-label="${leave ? 'Leave list' : 'Delete list'}">${leave ? '🚪' : '🗑'}</button>
    </div>
    ${total > 0 ? `<div class="progress-wrap">
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill ${allDone?'full':''}" style="width:${pct}%"></div>
      </div>
      <span class="progress-label">${pct}%</span>
      <button class="clear-done-btn" data-action="clear-done" ${done ? '' : 'hidden'}>Clear done</button>
    </div>` : ''}
    <ul class="items-list">${itemsHtml}</ul>
    <div class="all-done-banner ${allDone?'show':''}">🎊 All done! You're amazing!</div>
    <div class="add-row">
      <span class="add-row-icon" aria-hidden="true">🌸</span>
      <input class="add-input" id="newItemInput" type="text" placeholder="Add something…" maxlength="100"
        value="${escHtml(addDrafts[list.id] || '')}" data-field="add" data-focus-key="add:${lid}" aria-label="New item">
      <button class="add-btn" data-action="add-item" aria-label="Add item">＋</button>
    </div>
  </div>`;
}

// ─── TOAST ────────────────────────────────────────────────────────────
let toastTimer = null;
let toastUndo = null;

function showToast(message, undo) {
  const el = document.getElementById('toast');
  toastUndo = undo || null;
  el.innerHTML = `<span>${escHtml(message)}</span>`
    + (undo ? `<button class="toast-undo" data-action="undo">Undo</button>` : '');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastUndo = null;
  document.getElementById('toast')?.classList.remove('show');
}

// ─── ACTIONS ──────────────────────────────────────────────────────────
function switchList(id) { activeId = id; render(); }

function addItem(listId) {
  const inp = document.getElementById('newItemInput');
  const list = findList(listId);
  const text = inp.value.trim();
  if (!text || !list) return;
  const item = { id: uid(), text, done: false };
  list.items.push(item);
  inp.value = '';
  addDrafts[listId] = '';
  justAddedId = item.id;
  scheduleSave();
  render();
  document.getElementById('newItemInput')?.focus();
}

function toggleItem(listId, itemId, checked) {
  const list = findList(listId);
  const item = findItem(listId, itemId);
  if (!item) return;
  item.done = checked;
  scheduleSave();
  // Updated in place rather than re-rendered, so the checkbox and progress
  // bar animate and nothing else on screen is disturbed.
  document.querySelector(`.item-row[data-item="${CSS.escape(itemId)}"] .item-text`)?.classList.toggle('done', checked);
  updateProgress(list);
  updateSubtitle();
}

function editItem(listId, itemId, input) {
  const item = findItem(listId, itemId);
  if (!item) return;
  const text = input.value.trim();
  if (!text) { input.value = item.text; return; } // items can't be blank: put the old text back
  input.value = text;
  if (text === item.text) return;
  item.text = text;
  input.closest('.item-row')?.querySelector('input[type="checkbox"]')?.setAttribute('aria-label', text);
  scheduleSave();
}

function deleteItem(listId, itemId) {
  const list = findList(listId);
  const index = list ? list.items.findIndex(i => i.id === itemId) : -1;
  if (index < 0) return;
  const [item] = list.items.splice(index, 1);
  scheduleSave();
  render();
  showToast(`Deleted "${shorten(item.text)}"`, () => {
    const l = findList(listId);
    if (!l || l.items.some(i => i.id === item.id)) return;
    l.items.splice(Math.min(index, l.items.length), 0, item);
    justAddedId = item.id;
    scheduleSave();
    render();
  });
}

// Removes all ticked items; Undo puts them back where they were, keeping
// anything added in the meantime.
function clearDone(listId) {
  const list = findList(listId);
  if (!list) return;
  const before = list.items.slice();
  const removed = before.filter(i => i.done);
  if (!removed.length) return;
  list.items = before.filter(i => !i.done);
  scheduleSave();
  render();
  showToast(`Cleared ${removed.length} done item${removed.length === 1 ? '' : 's'}`, () => {
    const l = findList(listId);
    if (!l) return;
    const current = new Map(l.items.map(i => [i.id, i]));
    const removedIds = new Set(removed.map(i => i.id));
    const restored = before
      .filter(i => current.has(i.id) || removedIds.has(i.id))
      .map(i => current.get(i.id) || i);
    l.items.forEach(i => { if (!before.some(b => b.id === i.id)) restored.push(i); });
    l.items = restored;
    scheduleSave();
    render();
  });
}

function renameList(listId, input) {
  const list = findList(listId);
  if (!list) return;
  const name = input.value.trim();
  if (!name) { input.value = list.name; return; } // lists can't be nameless: put the old name back
  input.value = name;
  if (name === list.name) return;
  list.name = name;
  scheduleSave();
  renderTabs();
}

// Deleting a list you own removes it for everyone it's shared with; on a
// list shared with you, the same button leaves it. Either way the cloud
// isn't touched until the Undo window has passed (see applyRemovals).
function deleteList(listId) {
  const index = lists.findIndex(l => l.id === listId);
  if (index < 0) return;
  const info = shareInfo[listId];
  const leave = info?.mine === false;
  const others = info ? info.members - 1 : 0;
  const [list] = lists.splice(index, 1);
  removals[listId] = { leave, at: Date.now() };
  activeId = lists[Math.min(index, lists.length - 1)]?.id || null;
  scheduleSave();
  render();
  const name = shorten(list.name);
  showToast(leave ? `Left “${name}”` : others > 0 ? `Deleted “${name}” for everyone` : `Deleted list “${name}”`, () => {
    if (!removals[listId]) return; // already done in the cloud
    delete removals[listId];
    if (!findList(list.id)) lists.splice(Math.min(index, lists.length), 0, list);
    activeId = list.id;
    scheduleSave();
    render();
  });
}

// ─── REORDER ──────────────────────────────────────────────────────────
// Items move by dragging the ⋮⋮ handle, or with the arrow keys while the
// handle is focused. While dragging, the row follows the finger and the
// rows it passes slide out of the way; the list is only re-rendered on drop.
let drag = null;

function moveItem(listId, from, to) {
  const list = findList(listId);
  if (!list || from === to || from < 0 || to < 0 || to >= list.items.length) return;
  const [item] = list.items.splice(from, 1);
  list.items.splice(to, 0, item);
  scheduleSave();
  render();
  announce(`Moved "${shorten(item.text)}" to position ${to + 1} of ${list.items.length}`);
}

// Screen-reader-only status line (#srStatus).
function announce(msg) {
  const el = document.getElementById('srStatus');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 50);
}

function startDrag(e, handle) {
  if (drag || e.button !== 0) return;
  const row = handle.closest('.item-row');
  const listEl = row.parentElement;
  const rows = [...listEl.querySelectorAll('.item-row')];
  const from = rows.indexOf(row);
  drag = {
    listId: handle.closest('[data-list]').dataset.list,
    pointerId: e.pointerId, row, rows, listEl, from, to: from,
    startY: e.clientY, lastY: e.clientY, startScroll: window.scrollY,
    // Row midpoints in page coordinates, so scrolling mid-drag doesn't throw them off.
    mids: rows.map(r => { const b = r.getBoundingClientRect(); return b.top + window.scrollY + b.height / 2; }),
    step: row.getBoundingClientRect().height,
    scrollTimer: null
  };
  handle.setPointerCapture(e.pointerId);
  row.classList.add('dragging');
  listEl.classList.add('reordering');
  e.preventDefault();
}

function updateDrag() {
  const d = drag;
  const dy = d.lastY - d.startY + (window.scrollY - d.startScroll);
  d.row.style.transform = `translateY(${dy}px)`;
  const center = d.mids[d.from] + dy;
  d.to = d.mids.filter((m, i) => i !== d.from && m < center).length;
  d.rows.forEach((r, i) => {
    if (i === d.from) return;
    const shift = d.from < d.to && i > d.from && i <= d.to ? -d.step
      : d.from > d.to && i >= d.to && i < d.from ? d.step : 0;
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function moveDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.lastY = e.clientY;
  updateDrag();
  // Near the top (below the sticky header) or bottom of the screen, keep
  // scrolling so items can be dragged past what's visible.
  const top = (document.querySelector('.header')?.getBoundingClientRect().bottom || 0) + 40;
  const speed = e.clientY < top ? -8 : e.clientY > innerHeight - 60 ? 8 : 0;
  clearInterval(drag.scrollTimer);
  if (speed) drag.scrollTimer = setInterval(() => { window.scrollBy(0, speed); updateDrag(); }, 16);
}

function finishDrag(commit) {
  const d = drag;
  if (!d) return;
  drag = null;
  clearInterval(d.scrollTimer);
  d.rows.forEach(r => { r.style.transform = ''; });
  d.row.classList.remove('dragging');
  d.listEl.classList.remove('reordering');
  if (commit && d.to !== d.from) moveItem(d.listId, d.from, d.to);
}

// ─── SHARING ──────────────────────────────────────────────────────────
// A list is shared with an invite link: the Share sheet makes a single-use
// link (valid 7 days), and whoever opens it while logged in joins the list
// as an editor (accept_invite in supabase-setup.sql). The owner can remove
// people; everyone else can leave.
let shareListId = null;
let shareUrl = '';

function randomCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function setShareNote(msg) { document.getElementById('shareNote').textContent = msg; }

function openShareSheet(listId) {
  const list = findList(listId);
  if (!list) return;
  shareListId = listId;
  shareUrl = '';
  document.getElementById('shareTitle').textContent = `Share “${shorten(list.name, 24)}”`;
  document.getElementById('shareLinkRow').hidden = true;
  document.getElementById('shareLinkInput').value = '';
  document.getElementById('shareCreateBtn').hidden = false;
  document.getElementById('shareCopyBtn').hidden = true;
  document.getElementById('shareSendBtn').hidden = true;
  setShareNote('');
  renderMembers(null);
  openSheet('shareOverlay', 'shareCreateBtn');
  loadMembers(listId);
}

async function createInviteLink() {
  const listId = shareListId;
  const btn = document.getElementById('shareCreateBtn');
  btn.disabled = true;
  setShareNote('');
  try {
    // The list has to exist in the cloud before anyone can join it.
    if (!meta[listId]?.at) await sync();
    if (!meta[listId]?.at) throw new Error('This list hasn’t reached the cloud yet. Try again when you’re online.');
    const code = randomCode();
    const { error } = await supabaseClient.from('list_invites').insert({ code, list_id: listId });
    if (error) throw error;
    if (shareListId !== listId) return;
    const url = new URL('./', location.href);
    url.searchParams.set('invite', code);
    shareUrl = url.href;
    document.getElementById('shareLinkInput').value = shareUrl;
    document.getElementById('shareLinkRow').hidden = false;
    btn.hidden = true;
    document.getElementById('shareCopyBtn').hidden = false;
    document.getElementById('shareSendBtn').hidden = !navigator.share;
    setShareNote('Works once, for 7 days. The other person needs a Checklister account.');
    document.getElementById('shareCopyBtn').focus();
  } catch (e) {
    setShareNote('❌ ' + (e.message || 'Could not create the link'));
  } finally {
    btn.disabled = false;
  }
}

async function copyInviteLink() {
  try {
    await navigator.clipboard.writeText(shareUrl);
    setShareNote('Link copied ✓ Send it to the person you want to share with.');
  } catch (e) {
    const input = document.getElementById('shareLinkInput');
    input.focus();
    input.select();
    setShareNote('Copy the selected link and send it to the person you want to share with.');
  }
}

async function sendInviteLink() {
  const list = findList(shareListId);
  try {
    await navigator.share({ title: 'Checklister', text: `Join my list “${list ? list.name : ''}” on Checklister`, url: shareUrl });
  } catch (e) { /* share sheet closed */ }
}

async function loadMembers(listId) {
  if (!meta[listId]?.at) { renderMembers([]); return; } // not in the cloud yet: just you
  const { data, error } = await supabaseClient.rpc('list_members_with_email', { p_list_id: listId });
  if (shareListId !== listId) return;
  if (error) {
    document.getElementById('memberList').innerHTML = '<li class="member-note">Couldn’t load who has access.</li>';
    return;
  }
  renderMembers(data || []);
}

function renderMembers(members) {
  const el = document.getElementById('memberList');
  if (!members) { el.innerHTML = '<li class="member-note">Loading…</li>'; return; }
  const owner = shareInfo[shareListId]?.mine !== false;
  const rows = members.length ? members.map(m => {
    const you = m.user_id === currentUser?.id;
    return `<li class="member">
      <span class="member-email">${escHtml(m.email || 'Unknown')}${you ? ' <em>(you)</em>' : ''}</span>
      ${m.role === 'owner' ? '<span class="member-role">Owner</span>' : ''}
      ${owner && !you ? `<button class="member-remove" data-action="remove-member" data-user="${escHtml(m.user_id)}">Remove</button>` : ''}
    </li>`;
  }).join('') : '<li class="member-note">Just you so far.</li>';
  el.innerHTML = rows + (owner ? '' : '<li><button class="member-leave" data-action="leave-list">Leave this list</button></li>');
}

async function removeMember(userId) {
  const listId = shareListId;
  const { error } = await supabaseClient.from('list_members').delete().eq('list_id', listId).eq('user_id', userId);
  if (error) { setShareNote('❌ ' + error.message); return; }
  setShareNote('Removed. They no longer see this list.');
  loadMembers(listId);
  sync({ pull: true });
}

function hasPendingInvite() {
  try { return !!sessionStorage.getItem('checklister_invite'); } catch (e) { return false; }
}

// After logging in from an invite link: join the list and open it.
async function acceptPendingInvite() {
  let code = null;
  try { code = sessionStorage.getItem('checklister_invite'); } catch (e) {}
  const user = currentUser;
  if (!code || !user) return;
  const { data: listId, error } = await supabaseClient.rpc('accept_invite', { p_code: code });
  if (currentUser !== user) return;
  if (error && /fetch|network|abort/i.test(error.message || '')) {
    showToast('Couldn’t open the invite while offline. It’ll be tried again when you’re back online.');
    return; // keep the code for the next try
  }
  try { sessionStorage.removeItem('checklister_invite'); } catch (e) {}
  if (error) { showToast(error.message || 'Couldn’t open the invite'); return; }
  await sync({ pull: true });
  const list = findList(listId);
  if (!list) { showToast('You joined the list. It will appear in a moment.'); return; }
  activeId = list.id;
  render();
  showToast(`You joined “${shorten(list.name)}” 🎉`);
}

function setupShareEvents() {
  document.getElementById('memberList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'remove-member') removeMember(btn.dataset.user);
    else if (btn.dataset.action === 'leave-list') {
      const listId = shareListId;
      sheetReturnFocus = null;
      closeSheet('shareOverlay');
      deleteList(listId);
    }
  });
}

// ─── SHEETS ───────────────────────────────────────────────────────────
// Bottom sheets ("New List", "Choose a new password") are dialogs: Escape
// closes them, Tab stays inside, and focus goes back where it came from.
let sheetReturnFocus = null;

function openSheet(id, focusId) {
  sheetReturnFocus = document.activeElement;
  document.getElementById(id).classList.add('open');
  setTimeout(() => document.getElementById(focusId)?.focus(), 300);
}

function closeSheet(id) {
  const overlay = document.getElementById(id);
  if (!overlay || !overlay.classList.contains('open')) return;
  overlay.classList.remove('open');
  if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus();
  sheetReturnFocus = null;
}

function onSheetKeydown(e) {
  const overlay = document.querySelector('.overlay.open');
  if (!overlay) return;
  if (e.key === 'Escape') { closeSheet(overlay.id); return; }
  if (e.key !== 'Tab') return;
  const focusable = [...overlay.querySelectorAll('input:not([type="hidden"]), button')].filter(el => el.offsetParent !== null);
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openModal() {
  document.getElementById('modalInput').value = '';
  openSheet('overlay', 'modalInput');
}

function closeModal() { closeSheet('overlay'); }

function confirmModal() {
  const name = document.getElementById('modalInput').value.trim();
  if (!name) return;
  const l = {id:uid(), name, items:[]};
  lists.push(l);
  activeId = l.id;
  scheduleSave();
  render();
  sheetReturnFocus = null;
  closeModal();
  document.getElementById('newItemInput')?.focus(); // next step: add the first item
}

// ─── PASSWORD RESET ───────────────────────────────────────────────────
// "Forgot password?" emails a link back to this page. Opening it signs the
// user in with a recovery session, and we ask for a new password.
async function sendPasswordReset() {
  hideAuthMessages();
  const emailEl = document.getElementById('emailInput');
  const email = emailEl.value.trim();
  if (!email) { showAuthError('Enter your email above first'); emailEl.focus(); return; }
  const btn = document.getElementById('forgotBtn');
  btn.disabled = true;
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: new URL('./', location.href).href
    });
    if (error) throw error;
    // Same message whether or not the account exists, so the form can't be
    // used to find out who has an account.
    showAuthSuccess('If there\'s an account for that email, a reset link is on its way.');
  } catch (e) {
    showAuthError(e.message || 'Could not send the reset email');
  } finally {
    btn.disabled = false;
  }
}

function openPasswordSheet() {
  if (document.getElementById('pwOverlay').classList.contains('open')) return;
  document.getElementById('newPwInput').value = '';
  document.getElementById('pwError').classList.remove('show');
  document.getElementById('pwUsername').value = currentUser?.email || '';
  openSheet('pwOverlay', 'newPwInput');
}

async function saveNewPassword() {
  const pw = document.getElementById('newPwInput').value;
  const err = document.getElementById('pwError');
  err.classList.remove('show');
  if (pw.length < 6) { err.textContent = '❌ Password must be at least 6 characters'; err.classList.add('show'); return; }
  const btn = document.getElementById('pwSaveBtn');
  btn.disabled = true;
  try {
    const { error } = await supabaseClient.auth.updateUser({ password: pw });
    if (error) throw error;
    sheetReturnFocus = null;
    closeSheet('pwOverlay');
    showToast('Password updated ✓');
  } catch (e) {
    err.textContent = '❌ ' + (e.message || 'Could not update the password');
    err.classList.add('show');
  } finally {
    btn.disabled = false;
  }
}

// One listener per container instead of inline handlers in the generated
// HTML. Rows and cards carry their ids in data-item / data-list.
function setupListEvents() {
  const tabs = document.getElementById('listTabs');
  const main = document.getElementById('mainContent');
  const ids = el => ({
    listId: el.closest('[data-list]')?.dataset.list,
    itemId: el.closest('[data-item]')?.dataset.item
  });

  tabs.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'switch-list') switchList(btn.dataset.list);
    else if (btn.dataset.action === 'new-list') openModal();
  });

  main.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { listId, itemId } = ids(btn);
    switch (btn.dataset.action) {
      case 'add-item':    addItem(listId); break;
      case 'delete-item': deleteItem(listId, itemId); break;
      case 'delete-list': deleteList(listId); break;
      case 'share-list':  openShareSheet(listId); break;
      case 'clear-done':  clearDone(listId); break;
      case 'retry':       sync({ pull: true }); break;
    }
  });

  main.addEventListener('change', e => {
    if (e.target.dataset.action !== 'toggle') return;
    const { listId, itemId } = ids(e.target);
    toggleItem(listId, itemId, e.target.checked);
  });

  main.addEventListener('input', e => {
    if (e.target.dataset.field === 'add') addDrafts[ids(e.target).listId] = e.target.value;
  });

  main.addEventListener('focusout', e => {
    const field = e.target.dataset.field;
    const { listId, itemId } = ids(e.target);
    if (field === 'item') editItem(listId, itemId, e.target);
    else if (field === 'title') renameList(listId, e.target);
  });

  main.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.drag-handle');
    if (handle) startDrag(e, handle);
  });
  main.addEventListener('pointermove', moveDrag);
  main.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) finishDrag(true); });
  main.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pointerId) finishDrag(false); });

  main.addEventListener('keydown', e => {
    if (e.target.classList.contains('drag-handle') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const { listId, itemId } = ids(e.target);
      const from = findList(listId)?.items.findIndex(i => i.id === itemId) ?? -1;
      moveItem(listId, from, from + (e.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    const field = e.target.dataset.field;
    if (!field || e.isComposing) return;
    const { listId, itemId } = ids(e.target);
    if (e.key === 'Enter') {
      if (field === 'add') addItem(listId);
      else e.target.blur();
    } else if (e.key === 'Escape' && field !== 'add') {
      // Throw away the edit: put the saved text back before blurring.
      const saved = field === 'title' ? findList(listId)?.name : findItem(listId, itemId)?.text;
      if (saved != null) e.target.value = saved;
      e.target.blur();
    }
  });

  document.getElementById('toast').addEventListener('click', e => {
    if (!e.target.closest('[data-action="undo"]') || !toastUndo) return;
    const undo = toastUndo;
    hideToast();
    undo();
  });
}

// ─── STARTUP ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupListEvents();
  document.querySelectorAll('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeSheet(o.id); }));
  document.getElementById('modalInput').addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.isComposing) confirmModal(); });
  document.getElementById('newPwInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) saveNewPassword(); });
  document.addEventListener('keydown', onSheetKeydown);
  // Enter in a field submits; Enter on a button (eye, "Forgot password?") just presses it.
  document.getElementById('authForm').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') submitAuth(); });

  const redirectError = authRedirect.get('error_description');
  if (redirectError) {
    showAuthError(redirectError.replace(/\+/g, ' ') + '. You can request a new link below.');
    history.replaceState(null, '', location.pathname);
  }

  // Restore an existing session (e.g. page refresh) without re-prompting login.
  supabaseClient.auth.getSession().then(({ data }) => {
    if (data.session) {
      onLoggedIn(data.session.user);
      if (authRedirect.get('type') === 'recovery') openPasswordSheet();
    } else {
      document.documentElement.classList.remove('has-session'); // saved session had expired
      if (hasPendingInvite()) showAuthSuccess('Log in to join the list you were invited to.');
      setTimeout(() => document.getElementById('emailInput').focus(), 100);
    }
  });

  // Every way a session ends goes through resetToLoginScreen(), so the app
  // never stays on screen without a user.
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      resetToLoginScreen();
    } else if (event === 'PASSWORD_RECOVERY' && session) {
      if (!currentUser) onLoggedIn(session.user);
      openPasswordSheet();
    }
  });

  // Push pending edits as soon as the app is backgrounded or closed, and
  // pick up changes from other devices when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (!currentUser) return;
    if (document.visibilityState === 'hidden') {
      if (hasPending()) { clearTimeout(saveTimer); sync(); }
    } else if (Date.now() - lastPull > 5000) {
      sync({ pull: true });
    }
  });
  window.addEventListener('online', () => {
    if (!currentUser) return;
    sync({ pull: true });
    acceptPendingInvite();
  });
  setupShareEvents();
});

// Registered for everyone (not just after login) so the login screen also
// works offline. Waits for `load` so it doesn't compete with the first paint.
window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }
});
