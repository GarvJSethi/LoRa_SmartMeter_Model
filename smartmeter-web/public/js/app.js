// App shell. One sign-in page, then two different sites:
//   users  -> Wattwise (warm, dark, about their own home)
//   admins -> Wattwise Console (light, blue, about every meter)
import { api, connectStream, closeStream, on } from './api.js';
import { state, esc, $, icons, logo, toast, ago } from './ui.js';
import { signIn, signOut, authConfig } from './auth.js';

const USER_ROUTES = {
  '/': { title: 'Overview', icon: 'home', load: () => import('./pages/dashboard.js') },
  '/timeline': { title: 'Timeline', icon: 'timeline', load: () => import('./pages/timeline.js') },
  '/usage': { title: 'Usage & cost', icon: 'usage', load: () => import('./pages/usage.js') },
  '/alerts': { title: 'Alerts', icon: 'bell', load: () => import('./pages/alerts.js') },
  '/settings': { title: 'Settings', icon: 'settings', load: () => import('./pages/settings.js') },
};
const ADMIN_ROUTES = {
  '/admin': { title: 'Fleet', icon: 'meter', load: () => import('./pages/admin-meters.js') },
  '/admin/live': { title: 'Live view', icon: 'bolt', load: () => import('./pages/admin-live.js') },
  '/admin/users': { title: 'Users', icon: 'users', load: () => import('./pages/admin-users.js') },
  '/admin/model': { title: 'Model', icon: 'brain', load: () => import('./pages/admin-model.js') },
  '/admin/label': { title: 'Labelling', icon: 'tag', load: () => import('./pages/admin-label.js') },
  '/admin/raw': { title: 'Raw feed', icon: 'code', load: () => import('./pages/admin-raw.js') },
  '/admin/alerts': { title: 'Alerts', icon: 'bell', load: () => import('./pages/alerts.js') },
};
const consoleMark = `<svg width="18" height="18" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="#2f6bff" stroke-width="2"/><path d="M13 6.5 8.5 13H12l-1 4.5L15.5 11H12z" fill="#2f6bff"/></svg>`;

let cleanup = null, unread = 0;
const app = $('#app');
const path = () => location.hash.replace(/^#/, '') || '/';
const isAdmin = () => state.me?.role === 'admin';
const routes = () => (isAdmin() ? ADMIN_ROUTES : USER_ROUTES);
const home = () => (isAdmin() ? '/admin' : '/');

// ---------------------------------------------------------------- sign in (shared)
async function renderLogin() {
  closeStream();
  document.body.className = '';
  const cfg = await authConfig().catch(() => ({ auth: 'local' }));
  app.innerHTML = `
  <div class="login-wrap">
    <section class="login-art">
      <a class="brand" href="#/"><span class="brand-mark">${logo}</span>Wattwise</a>
      <div>
        <h2>Know what's running before the bill does.</h2>
        <p class="mt">Live power, appliance detection and time-of-day cost from your smart meter, updated every second.</p>
        <svg class="wave mt" viewBox="0 0 460 120" width="100%" height="120" aria-hidden="true">
          <defs><linearGradient id="lw" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff7a2f" stop-opacity=".35"/><stop offset="1" stop-color="#ff7a2f" stop-opacity="0"/></linearGradient></defs>
          <path d="M0 96 L60 96 L64 70 L120 70 L124 40 L190 40 L194 74 L250 74 L254 22 L300 22 L304 74 L360 74 L364 92 L460 92 L460 120 L0 120Z" fill="url(#lw)"/>
          <path d="M0 96 L60 96 L64 70 L120 70 L124 40 L190 40 L194 74 L250 74 L254 22 L300 22 L304 74 L360 74 L364 92 L460 92" fill="none" stroke="#ff7a2f" stroke-width="2"/>
        </svg>
      </div>
      <p class="faint" style="font-size:13px">BTP smart energy meter · STPM33 · on-chip appliance detection</p>
    </section>
    <section class="login-form">
      <form class="login-box" id="login">
        <h1>Sign in</h1>
        <p class="muted" style="margin:-6px 0 6px">Households see their home. Administrators are taken to the console.</p>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <div class="form-error" id="login-err"></div>
        <button class="btn primary" style="height:42px">Sign in</button>
        <p class="faint" style="font-size:12.5px;margin:4px 0 0">${cfg.auth === 'supabase' ? 'Secured by Supabase Auth' : 'Local accounts'}</p>
      </form>
    </section>
  </div>`;
  $('#login').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await signIn(f.email.trim(), f.password);
      location.hash = r.role === 'admin' ? '#/admin' : '#/';
      await boot();
    } catch (err) { $('#login-err').textContent = err.message; btn.disabled = false; btn.textContent = 'Sign in'; }
  });
  $('input[name=email]').focus();
}

async function logout() {
  await signOut();
  state.me = null;
  location.hash = '#/';
  renderLogin();
}

// ---------------------------------------------------------------- user site
function renderUserShell() {
  document.body.className = 'theme-user';
  const link = (p, r) => `<a href="#${p}" data-path="${p}">${icons[r.icon]}<span>${r.title}</span>${p === '/alerts' ? '<span class="badge hidden" data-unread></span>' : ''}</a>`;
  app.innerHTML = `
  <div class="shell">
    <aside class="side">
      <a class="brand" href="#/"><span class="brand-mark">${logo}</span>Wattwise</a>
      <nav class="nav">${Object.entries(USER_ROUTES).map(([p, r]) => link(p, r)).join('')}</nav>
      <div class="side-foot">
        <div class="who">${esc(state.me.name)}</div>
        <div class="faint" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">${esc(state.me.email)}</div>
        <button class="btn ghost sm mt-s" id="logout" style="padding:0;height:auto">${icons.logout} Sign out</button>
      </div>
    </aside>
    <div class="main">
      <header class="top">
        <a class="brand-mini brand" href="#/"><span class="brand-mark">${logo}</span></a>
        <h1 id="page-title"></h1>
        <div class="spacer"></div>
        <span class="chip" id="live-chip"><span class="dot"></span><span>Connecting</span></span>
        <select class="input" id="meter-select" aria-label="Meter" style="max-width:220px;height:34px"></select>
        <button class="btn ghost sm user-out" id="logout-m" aria-label="Sign out">${icons.logout}</button>
      </header>
      <div id="page"></div>
    </div>
    <nav class="tabbar">
      ${Object.entries(USER_ROUTES).map(([p, r]) => `<a href="#${p}" data-path="${p}">${icons[r.icon]}<span>${r.title.split(' ')[0]}</span></a>`).join('')}
    </nav>
  </div>`;
  $('#logout').addEventListener('click', logout);
  $('#logout-m').addEventListener('click', logout);
  const sel = $('#meter-select');
  sel.innerHTML = state.meters.length ? state.meters.map(m => `<option value="${esc(m.deviceId)}">${esc(m.name)}</option>`).join('') : '<option value="">No meter</option>';
  sel.value = state.meterId || '';
  sel.classList.toggle('hidden', state.meters.length <= 1);
  sel.addEventListener('change', () => { state.meterId = sel.value; localStorage.setItem('meterId', sel.value); updateLiveChip(); route(); });
  updateLiveChip();
}

// ---------------------------------------------------------------- admin console
function renderAdminShell() {
  document.body.className = 'theme-admin';
  app.innerHTML = `
  <div class="console">
    <header class="c-top">
      <a class="c-brand" href="#/admin">${consoleMark}<span>Wattwise</span><span class="c-tag">Console</span></a>
      <nav class="c-nav">
        ${Object.entries(ADMIN_ROUTES).map(([p, r]) => `<a href="#${p}" data-path="${p}">${icons[r.icon]}<span>${r.title}</span>${p === '/admin/alerts' ? '<span class="badge hidden" data-unread></span>' : ''}</a>`).join('')}
      </nav>
      <div class="c-right">
        <span class="c-status" id="mqtt-chip"><span class="dot"></span><span>Connecting</span></span>
        <div class="c-user">
          <span class="c-avatar">${esc((state.me.name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span>
          <span class="c-user-text"><b>${esc(state.me.name)}</b><small>Administrator</small></span>
          <button class="btn ghost sm" id="logout" aria-label="Sign out" title="Sign out">${icons.logout}</button>
        </div>
      </div>
    </header>
    <main class="c-main"><div class="c-crumb"><span>Console</span><span class="sep">/</span><b id="page-title"></b></div><div id="page"></div></main>
  </div>`;
  $('#logout').addEventListener('click', logout);
  updateMqttChip();
}
async function updateMqttChip() {
  const chip = $('#mqtt-chip'); if (!chip) return;
  const h = await api('/api/health').catch(() => null);
  const online = state.meters.filter(m => m.status === 'online').length;
  chip.innerHTML = h?.mqtt ? `<span class="dot online"></span><span>Broker connected · ${online}/${state.meters.length} online</span>`
    : '<span class="dot offline"></span><span>Broker disconnected</span>';
  chip.title = h?.broker || '';
}

// ---------------------------------------------------------------- shared bits
function updateLiveChip() {
  const chip = $('#live-chip'); if (!chip) return;
  const m = state.meters.find(x => x.deviceId === state.meterId);
  if (!m) { chip.innerHTML = '<span class="dot"></span><span>No meter</span>'; return; }
  chip.innerHTML = m.status === 'online' ? '<span class="dot live"></span><span>Live</span>'
    : `<span class="dot offline"></span><span>${m.status === 'never' ? 'Waiting for data' : `Offline · ${esc(ago(m.lastSeen))}`}</span>`;
  chip.title = `${m.deviceId}${m.lastSeen ? ` · last reading ${ago(m.lastSeen)}` : ''}`;
}
function setUnread(n) {
  unread = n;
  document.querySelectorAll('[data-unread]').forEach(b => { b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n); });
}

async function route() {
  if (!state.me) return;
  const p = path();
  const r = routes()[p];
  if (!r) { location.hash = `#${home()}`; return; }   // users cannot open console pages and vice versa
  document.querySelectorAll('[data-path]').forEach(a => a.classList.toggle('active', a.dataset.path === p));
  $('#page-title').textContent = r.title;
  document.title = `${r.title} · ${isAdmin() ? 'Wattwise Console' : 'Wattwise'}`;
  try { cleanup?.(); } catch {}
  cleanup = null;
  const page = $('#page');
  page.innerHTML = '<div class="page"><div class="skeleton" style="height:140px"></div></div>';
  try {
    const mod = await r.load();
    if (path() !== p) return;
    page.innerHTML = '<div class="page"></div>';
    cleanup = (await mod.render(page.firstElementChild, { setUnread, refreshMeters })) || null;
  } catch (e) {
    console.error(e);
    page.innerHTML = `<div class="page"><div class="card empty">Could not load this page: ${esc(e.message)}</div></div>`;
  }
}

async function refreshMeters() {
  state.meters = await api('/api/meters');
  if (!state.meters.some(m => m.deviceId === state.meterId)) state.meterId = state.meters[0]?.deviceId || null;
  const sel = $('#meter-select');
  if (sel) { sel.innerHTML = state.meters.map(m => `<option value="${esc(m.deviceId)}">${esc(m.name)}</option>`).join(''); sel.value = state.meterId || ''; sel.classList.toggle('hidden', state.meters.length <= 1); }
  updateLiveChip();
}

async function boot() {
  try { state.me = await api('/api/me'); } catch { return renderLogin(); }
  await refreshMeters();
  const saved = localStorage.getItem('meterId');
  state.meterId = state.meters.find(m => m.deviceId === saved)?.deviceId
    || state.meters.find(m => m.status === 'online')?.deviceId || state.meters[0]?.deviceId || null;
  if (isAdmin()) renderAdminShell(); else renderUserShell();
  if (!routes()[path()]) location.hash = `#${home()}`;
  connectStream();
  const alerts = await api('/api/alerts?limit=200').catch(() => []);
  setUnread(alerts.filter(a => !a.read_at).length);
  route();
}

on('status', d => {
  const m = state.meters.find(x => x.deviceId === d.device);
  if (m) { m.status = d.status === 'online' ? 'online' : 'offline'; if (d.status === 'online') m.lastSeen = d.ts; }
  if (d.device === state.meterId) updateLiveChip();
  if (isAdmin()) updateMqttChip();
});
on('data', d => {
  const m = state.meters.find(x => x.deviceId === d.device);
  if (!m) { if (isAdmin()) refreshMeters(); return; }
  const wasOffline = m.status !== 'online';
  m.status = 'online'; m.lastSeen = d.ts; m.last = d.msg; m.confirmed = d.confirmed;
  if (wasOffline) { if (d.device === state.meterId) updateLiveChip(); if (isAdmin()) updateMqttChip(); }
});
on('alert', a => {
  setUnread(unread + 1);
  if (a.device === state.meterId || isAdmin()) toast(a.title, a.level === 'warn' ? 'bad' : '');
});
on('down', () => { const c = $('#live-chip'); if (c) c.innerHTML = '<span class="dot offline"></span><span>Reconnecting</span>'; });
on('open', () => updateLiveChip());
setInterval(() => { updateLiveChip(); if (isAdmin()) updateMqttChip(); }, 15_000);

window.addEventListener('hashchange', route);
window.addEventListener('auth:lost', () => { if (state.me) { state.me = null; toast('Your session ended. Please sign in again.'); renderLogin(); } });
boot();
