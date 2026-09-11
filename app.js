// ─── CONFIG ───────────────────────────────────────────────────────────
// This key is MEANT to be public — it's fine that it's visible on GitHub.
// Real access control lives in Supabase's Row Level Security policies
// (see supabase-setup.sql), not in hiding this key.
const SUPABASE_URL = 'https://bjdhtxtwreklnnseodjb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Ah_nnrgqnY5dVFJmpEtnZA_YawMCkzD';
// ──────────────────────────────────────────────────────────────────────

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let lists = [];
let activeId = null;
let saveTimer = null;
let appInited = false;
let currentUser = null;
let authMode = 'login'; // 'login' | 'signup'

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
  await supabaseClient.auth.signOut();
  // onAuthStateChange will fire with SIGNED_OUT and call resetToLoginScreen()
  // for us — see below. Calling it again here is harmless (idempotent).
  resetToLoginScreen();
}

// Fixed: this used to live only inside logOut(). If the session ended any
// other way (token expired, logged out in another tab, magic link flow),
// currentUser was cleared but the app screen stayed on screen — every
// save/load after that silently no-op'd because saveToDB() bails out when
// currentUser is null. Now both paths go through the same reset.
function resetToLoginScreen() {
  currentUser = null;
  lists = [];
  activeId = null;
  appInited = false;
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
  document.getElementById('mainContent').innerHTML = `<div class="loading-screen">
    <div class="loading-spinner"></div>
    <p>Loading your lists…</p>
  </div>`;
  loadFromDB();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }
}

// ─── SYNC ─────────────────────────────────────────────────────────────
function setSyncState(state) {
  const dot = document.getElementById('syncDot');
  if (!dot) return;
  dot.className = 'sync-dot' + (state === 'syncing' ? ' syncing' : state === 'error' ? ' error' : '');
  dot.title = state === 'ok' ? 'Saved to cloud ✓' : state === 'syncing' ? 'Saving…' : 'Sync error – saved locally';
}

async function loadFromDB() {
  try {
    setSyncState('syncing');
    // Fixed: was .maybeSingle(), which THROWS if more than one row matches
    // user_id (this happened in practice — see the upsert fix below and
    // supabase-setup.sql). That throw sent every load into the catch block,
    // silently falling back to local, empty-on-a-new-device storage, which
    // is almost certainly why "logging in doesn't show my lists" happened.
    // Ordering by most-recent and taking the first row is self-healing even
    // against old duplicate rows left over from before the fix.
    const { data, error } = await supabaseClient
      .from('checklists')
      .select('data')
      .eq('user_id', currentUser.id)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    lists = (data && data[0] && data[0].data) || [];
    activeId = lists[0]?.id || null;
    setSyncState('ok');
  } catch (e) {
    console.warn('DB load failed, using localStorage:', e);
    loadFallback();
    setSyncState('error');
  }
  render();
}

async function saveToDB() {
  if (!currentUser) return;
  localStorage.setItem('checklister_' + currentUser.id, JSON.stringify(lists));
  setSyncState('syncing');
  try {
    // Fixed: upsert() without onConflict resolves conflicts on the table's
    // PRIMARY KEY (id), not on user_id. Since every save used the same
    // user_id but a fresh row, this was inserting a brand-new row every
    // single time instead of updating the existing one — one user could end
    // up with hundreds of rows, and only "checklists_user_id_key" (added in
    // supabase-setup.sql) makes onConflict: 'user_id' actually work.
    const { error } = await supabaseClient
      .from('checklists')
      .upsert(
        { user_id: currentUser.id, data: lists, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
    if (error) throw error;
    setSyncState('ok');
  } catch (e) {
    console.warn('DB save failed:', e);
    setSyncState('error');
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDB, 600);
}

function loadFallback() {
  lists = JSON.parse(localStorage.getItem('checklister_' + currentUser.id) || '[]');
  activeId = lists[0]?.id || null;
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
});