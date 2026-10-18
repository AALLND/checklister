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
  if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🙈'; }
  else { inp.type = 'password'; btn.textContent = '👁'; }
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
  sync().then(() => { if (currentUser === user) render(); });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }
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
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── RENDER ───────────────────────────────────────────────────────────
function render() {
  renderTabs();
  renderContent();
  const sub = document.getElementById('subtitle');
  if (!sub) return;
  if (!lists.length) { sub.textContent = 'Start by creating a list 💫'; return; }
  const total = lists.reduce((a,l) => a + l.items.length, 0);
  const done  = lists.reduce((a,l) => a + l.items.filter(i=>i.done).length, 0);
  sub.textContent = total ? `${done} of ${total} done ${done===total && total>0 ? '🎉':''}`.trim() : 'Add some items!';
}

function renderTabs() {
  const el = document.getElementById('listTabs');
  if (!el) return;
  let h = '';
  lists.forEach(l => {
    const a = l.id === activeId ? 'active' : '';
    h += `<div class="tab ${a}" onclick="switchList('${l.id}')">
      ${escHtml(l.name)}
      <span class="tab-badge">${l.items.length}</span>
    </div>`;
  });
  h += `<button class="new-tab-btn" onclick="openModal()">＋ New List</button>`;
  el.innerHTML = h;
}

function renderContent() {
  const el = document.getElementById('mainContent');
  if (!el) return;

  if (!lists.length && !cloudChecked) {
    el.innerHTML = `<div class="no-lists">
      <div class="nl-icon">☁️</div>
      <h2>Can't reach the cloud</h2>
      <p>Your lists will show up as soon<br>as you're back online.</p>
      <button class="retry-btn" onclick="sync({ pull: true })">Try again</button>
    </div>`; return;
  }

  if (!lists.length) {
    el.innerHTML = `<div class="no-lists">
      <div class="nl-icon">🌸</div>
      <h2>No lists yet!</h2>
      <p>Tap <strong>＋ New List</strong> above<br>to create your first checklist~</p>
    </div>`; return;
  }

  el.innerHTML = getListHTML();
}

function getListHTML() {
  if (!lists.length) return '';
  const list = lists.find(l => l.id === activeId);
  if (!list) return '';

  const done  = list.items.filter(i=>i.done).length;
  const total = list.items.length;
  const pct   = total ? Math.round(done/total*100) : 0;
  const allDone = total > 0 && done === total;

  let itemsHtml = '';
  list.items.forEach(item => {
    const dc = item.done ? 'done' : '';
    itemsHtml += `<li class="item-row">
      <label class="cb-wrap">
        <input type="checkbox" ${item.done?'checked':''} onchange="toggleItem('${list.id}','${item.id}',this.checked)">
        <div class="cb-box"><span class="tick">✓</span></div>
      </label>
      <div class="item-text-wrap">
        <input class="item-text ${dc}" type="text" value="${escHtml(item.text)}"
          onblur="editItem('${list.id}','${item.id}',this.value)"
          onkeydown="if(event.key==='Enter')this.blur()">
      </div>
      <button class="item-del" onclick="deleteItem('${list.id}','${item.id}')">✕</button>
    </li>`;
  });

  if (!list.items.length) {
    itemsHtml = `<div class="empty-state">
      <div class="e-icon">🌸</div>
      <p>Nothing here yet~<br>Add your first item below!</p>
    </div>`;
  }

  return `<div class="list-card">
    <div class="card-header">
      <input class="card-title-input" type="text" value="${escHtml(list.name)}"
        onblur="renameList('${list.id}',this.value)"
        onkeydown="if(event.key==='Enter')this.blur()">
      <button class="del-list-btn" onclick="deleteList('${list.id}')" title="Delete list">🗑</button>
    </div>
    ${total > 0 ? `<div class="progress-wrap">
      <div class="progress-track">
        <div class="progress-fill ${allDone?'full':''}" style="width:${pct}%"></div>
      </div>
      <span class="progress-label">${pct}%</span>
    </div>` : ''}
    <ul class="items-list">${itemsHtml}</ul>
    <div class="all-done-banner ${allDone?'show':''}">🎊 All done! You're amazing!</div>
    <div class="add-row">
      <span class="add-row-icon">🌸</span>
      <input class="add-input" id="newItemInput" type="text" placeholder="Add something…" maxlength="100"
        onkeydown="if(event.key==='Enter')addItem('${list.id}')">
      <button class="add-btn" onclick="addItem('${list.id}')">＋</button>
    </div>
  </div>`;
}

// ─── ACTIONS ──────────────────────────────────────────────────────────
function switchList(id) { activeId = id; render(); }

function addItem(listId) {
  const inp = document.getElementById('newItemInput');
  const text = inp.value.trim();
  if (!text) return;
  lists.find(l=>l.id===listId).items.push({id:uid(), text, done:false});
  scheduleSave();
  render();
  setTimeout(()=>{ const n=document.getElementById('newItemInput'); if(n) n.focus(); }, 50);
}

function toggleItem(listId, itemId, checked) {
  lists.find(l=>l.id===listId).items.find(i=>i.id===itemId).done = checked;
  scheduleSave();
  render();
}

function editItem(listId, itemId, value) {
  const text = value.trim();
  if (!text) return;
  lists.find(l=>l.id===listId).items.find(i=>i.id===itemId).text = text;
  scheduleSave();
}

function deleteItem(listId, itemId) {
  const list = lists.find(l=>l.id===listId);
  list.items = list.items.filter(i=>i.id!==itemId);
  scheduleSave();
  render();
}

function renameList(listId, value) {
  const name = value.trim();
  if (!name) return;
  lists.find(l=>l.id===listId).name = name;
  scheduleSave();
  render();
}

function deleteList(listId) {
  if (!confirm('Delete this list? 🥺')) return;
  lists = lists.filter(l=>l.id!==listId);
  activeId = lists[0]?.id || null;
  scheduleSave();
  render();
}

function openModal() {
  document.getElementById('modalInput').value = '';
  document.getElementById('overlay').classList.add('open');
  setTimeout(()=>document.getElementById('modalInput').focus(), 300);
}
function closeModal() { document.getElementById('overlay').classList.remove('open'); }
function confirmModal() {
  const name = document.getElementById('modalInput').value.trim();
  if (!name) return;
  const l = {id:uid(), name, items:[]};
  lists.push(l);
  activeId = l.id;
  scheduleSave();
  render();
  closeModal();
}

// ─── STARTUP ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('overlay').addEventListener('click', function(e){ if(e.target===this) closeModal(); });
  document.getElementById('modalInput').addEventListener('keydown', e=>{ if(e.key==='Enter') confirmModal(); });
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
