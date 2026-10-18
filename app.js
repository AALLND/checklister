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

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: { fetch: fetchWithTimeout }
});

let lists = [];
let activeId = null;
let appInited = false;
let currentUser = null;
let authMode = 'login'; // 'login' | 'signup'

// Sync state. `base` is the last version of the lists we know is in the
// cloud, stamped with that row's `updated_at`. Local edits are diffed
// against it when another device has saved in the meantime.
let base = [];
let baseUpdatedAt = null;
let dirty = false;         // local edits not yet in the cloud
let editVersion = 0;       // bumped on every local edit
let cloudChecked = false;  // loaded from the cloud at least once this session
let lastPull = 0;
let saveTimer = null;
let retryTimer = null;
let retryDelay = 2000;
let syncChain = Promise.resolve();
let syncQueued = null;     // options for the run waiting in syncChain, if any

// ─── AUTH UI ──────────────────────────────────────────────────────────
function setAuthTab(mode) {
  authMode = mode;
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('tabSignup').classList.toggle('active', mode === 'signup');
  document.getElementById('authBtn').textContent = mode === 'login' ? 'Log in 🔓' : 'Sign up';
  document.getElementById('authSub').textContent = mode === 'login'
    ? 'Log in to see your lists 🔒'
    : 'Create an account to get started';
  // Fixed: password field was always tagged "current-password", which made
  // browsers offer to autofill an old saved password on the signup form
  // instead of letting them create a new one.
  document.getElementById('pwInput').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  hideAuthMessages();
}

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
    if (authMode === 'signup') {
      const { data, error } = await supabaseClient.auth.signUp({ email, password: pw });
      if (error) throw error;
      if (data.session) {
        // Email confirmation is off in project settings — logged in immediately.
        onLoggedIn(data.session.user);
      } else {
        showAuthSuccess('Check your email to confirm your account, then log in.');
        setAuthTab('login');
      }
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: pw });
      if (error) throw error;
      onLoggedIn(data.user);
    }
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
  if (dirty) await sync();
  if (dirty && !confirm('Some changes haven\'t reached the cloud yet. They stay saved on this device and sync the next time you log in here.\n\nLog out anyway?')) return;
  await supabaseClient.auth.signOut();
  // onAuthStateChange also fires SIGNED_OUT; resetting twice is harmless.
  resetToLoginScreen();
}

// Every way a session can end (logout, expired token, logout in another tab)
// goes through here, so the app never stays on screen without a user.
function resetToLoginScreen() {
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  currentUser = null;
  lists = [];
  activeId = null;
  base = [];
  baseUpdatedAt = null;
  dirty = false;
  cloudChecked = false;
  retryDelay = 2000;
  appInited = false;
  renderedListId = null;
  justAddedId = null;
  addDrafts = {};
  hideToast();
  closeModal();
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
    if (currentUser === user && document.querySelector('#mainContent .loading-screen')) render();
  });
}

// ─── SYNC ─────────────────────────────────────────────────────────────
// The whole set of lists is stored as one JSON row per user. Rules:
//  • Every edit is written to localStorage first (marked dirty), then pushed.
//  • Nothing is pushed until this session has loaded the cloud version, so a
//    stale or empty local copy can never overwrite newer cloud data.
//  • A push only overwrites the exact cloud version it was based on. If
//    another device saved in between, the two versions are merged and the
//    push is retried.
//  • Failed syncs retry with backoff, and when the device comes back online.
function setSyncState(state) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if (!dot) return;
  dot.className = 'sync-dot' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
  dot.title = state === 'ok' ? 'Saved to cloud ✓'
    : state === 'syncing' ? 'Syncing…'
    : dirty ? 'Offline – changes are saved on this device and will sync later'
    : 'Can\'t reach the cloud – retrying';
  if (label) label.textContent = state === 'error' ? 'Offline' : '';
}

function localKey() { return 'checklister_' + currentUser.id; }

function saveLocal() {
  try {
    localStorage.setItem(localKey(), JSON.stringify({ v: 2, lists, base, baseUpdatedAt, dirty }));
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
  lists = Array.isArray(stored.lists) ? stored.lists : [];
  base = Array.isArray(stored.base) ? stored.base : [];
  baseUpdatedAt = stored.baseUpdatedAt || null;
  dirty = !!stored.dirty;
  fixActiveId();
}

// Called after every local edit.
function scheduleSave() {
  dirty = true;
  editVersion++;
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
    if (dirty) await pushToCloud(user);
    retryDelay = 2000;
    setSyncState('ok');
  } catch (e) {
    if (currentUser !== user) return; // logged out mid-sync
    console.warn('Sync failed:', e);
    setSyncState('error');
    if (dirty || !cloudChecked) {
      retryTimer = setTimeout(() => sync(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    }
  }
}

function checkSameUser(user) {
  if (currentUser !== user) throw new Error('Session changed during sync');
}

async function pullFromCloud(user) {
  // Ordered + limit(1) rather than maybeSingle(), so leftover duplicate rows
  // from an old bug can't make the load fail.
  const { data, error } = await supabaseClient
    .from('checklists')
    .select('data, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(1);
  checkSameUser(user);
  if (error) throw error;

  lastPull = Date.now();
  const before = stableStr(lists);
  const row = data && data[0];
  if (!row) {
    // Nothing in the cloud yet: whatever is on this device gets uploaded.
    base = [];
    baseUpdatedAt = null;
    if (lists.length) dirty = true;
  } else if (row.updated_at !== baseUpdatedAt) {
    const remote = Array.isArray(row.data) ? row.data : [];
    lists = dirty ? mergeLists(base, lists, remote) : remote;
    base = remote;
    baseUpdatedAt = row.updated_at;
  }
  cloudChecked = true;
  saveLocal();
  if (stableStr(lists) !== before) { fixActiveId(); render(); }
}

async function pushToCloud(user) {
  let conflict = false;
  for (let attempt = 0; attempt < 3 && dirty; attempt++) {
    const snapshot = JSON.parse(JSON.stringify(lists));
    const version = editVersion;
    const now = new Date().toISOString();
    const res = baseUpdatedAt === null
      ? await supabaseClient
          .from('checklists')
          .insert({ user_id: user.id, data: snapshot, updated_at: now })
          .select('updated_at')
      // Only overwrite the version we started from. If another device saved
      // in the meantime, nothing matches and we merge instead.
      : await supabaseClient
          .from('checklists')
          .update({ data: snapshot, updated_at: now })
          .eq('user_id', user.id)
          .eq('updated_at', baseUpdatedAt)
          .select('updated_at');
    checkSameUser(user);
    const { data, error } = res;
    if (error && error.code !== '23505') throw error; // 23505: row already exists

    conflict = !!error || !data || !data.length;
    if (conflict) {
      await pullFromCloud(user); // merges the other device's version into ours
    } else {
      base = snapshot;
      baseUpdatedAt = data[0].updated_at;
      if (editVersion === version) dirty = false; // else: edited mid-push, go again
      saveLocal();
    }
  }
  if (dirty && conflict) throw new Error('Cloud kept changing during save');
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
  const { pct, allDone } = listStats(list);
  const fill = document.querySelector('.progress-fill');
  if (fill) { fill.style.width = pct + '%'; fill.classList.toggle('full', allDone); }
  const label = document.querySelector('.progress-label');
  if (label) label.textContent = pct + '%';
  document.querySelector('.all-done-banner')?.classList.toggle('show', allDone);
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
  const { total, pct, allDone } = listStats(list);
  const isNewCard = list.id !== renderedListId;
  const lid = escHtml(list.id);

  const itemsHtml = list.items.length ? list.items.map(item => {
    const iid = escHtml(item.id);
    const animate = isNewCard || item.id === justAddedId;
    return `<li class="item-row${animate ? ' slide-in' : ''}" data-item="${iid}">
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
      <button class="del-list-btn" data-action="delete-list" title="Delete list" aria-label="Delete list">🗑</button>
    </div>
    ${total > 0 ? `<div class="progress-wrap">
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill ${allDone?'full':''}" style="width:${pct}%"></div>
      </div>
      <span class="progress-label">${pct}%</span>
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

function deleteList(listId) {
  const index = lists.findIndex(l => l.id === listId);
  if (index < 0) return;
  const [list] = lists.splice(index, 1);
  activeId = lists[Math.min(index, lists.length - 1)]?.id || null;
  scheduleSave();
  render();
  showToast(`Deleted list "${shorten(list.name)}"`, () => {
    if (findList(list.id)) return;
    lists.splice(Math.min(index, lists.length), 0, list);
    activeId = list.id;
    scheduleSave();
    render();
  });
}

let modalReturnFocus = null;

function openModal() {
  modalReturnFocus = document.activeElement;
  document.getElementById('modalInput').value = '';
  document.getElementById('overlay').classList.add('open');
  setTimeout(()=>document.getElementById('modalInput').focus(), 300);
}

function closeModal() {
  const overlay = document.getElementById('overlay');
  if (!overlay.classList.contains('open')) return;
  overlay.classList.remove('open');
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function confirmModal() {
  const name = document.getElementById('modalInput').value.trim();
  if (!name) return;
  const l = {id:uid(), name, items:[]};
  lists.push(l);
  activeId = l.id;
  scheduleSave();
  render();
  modalReturnFocus = null;
  closeModal();
  document.getElementById('newItemInput')?.focus(); // next step: add the first item
}

// Keyboard support inside the "New List" sheet: Escape closes it and Tab
// stays within it.
function onModalKeydown(e) {
  if (!document.getElementById('overlay').classList.contains('open')) return;
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key !== 'Tab') return;
  const focusable = [...document.querySelectorAll('#overlay input, #overlay button')];
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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

  main.addEventListener('keydown', e => {
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
  document.getElementById('overlay').addEventListener('click', function(e){ if(e.target===this) closeModal(); });
  document.getElementById('modalInput').addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.isComposing) confirmModal(); });
  document.addEventListener('keydown', onModalKeydown);
  document.getElementById('authForm').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });

  // Restore an existing session (e.g. page refresh) without re-prompting login.
  supabaseClient.auth.getSession().then(({ data }) => {
    if (data.session) {
      onLoggedIn(data.session.user);
    } else {
      setTimeout(() => document.getElementById('emailInput').focus(), 100);
    }
  });

  // Fixed: previously only cleared `currentUser`, leaving the app screen
  // visible with a "logged-in" UI that could no longer actually save or
  // load anything. Now it fully resets the screen, same as a manual logout.
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      resetToLoginScreen();
    }
  });

  // Push pending edits as soon as the app is backgrounded or closed, and
  // pick up changes from other devices when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (!currentUser) return;
    if (document.visibilityState === 'hidden') {
      if (dirty) { clearTimeout(saveTimer); sync(); }
    } else if (Date.now() - lastPull > 5000) {
      sync({ pull: true });
    }
  });
  window.addEventListener('online', () => { if (currentUser) sync({ pull: true }); });
});

// Registered for everyone (not just after login) so the login screen also
// works offline. Waits for `load` so it doesn't compete with the first paint.
window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }
});
