// Shared helpers: escaping, formatting (IST), icons, toasts, modals.
export const state = { me: null, meters: [], meterId: null };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- formatting (fixed offset, India: +05:30)
const off = () => (state.me?.tzOffsetMin ?? 330) * 60_000;
const local = ts => new Date(ts + off());
const pad = n => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const fmtTime = ts => { const d = local(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
export const fmtTimeS = ts => { const d = local(ts); return `${fmtTime(ts)}:${pad(d.getUTCSeconds())}`; };
export const fmtDate = ts => { const d = local(ts); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export const fmtDay = ts => { const d = local(ts); return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export const fmtDateTime = ts => `${fmtDate(ts)}, ${fmtTime(ts)}`;
export const fmtMonth = ts => { const d = local(ts); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
export const localHour = ts => local(ts).getUTCHours() + local(ts).getUTCMinutes() / 60;
export const dayStart = ts => Math.floor((ts + off()) / 86_400_000) * 86_400_000 - off();
export const isoDay = ts => local(ts).toISOString().slice(0, 10);
export const fromIsoDay = s => Date.parse(`${s}T00:00:00Z`) - off();

export function fmtW(w, { unit = true } = {}) {
  if (w == null || !Number.isFinite(w)) return '–';
  const s = w >= 1000 ? (w / 1000).toFixed(w >= 10000 ? 1 : 2) : w >= 100 ? Math.round(w).toString() : w.toFixed(1);
  return unit ? `${s} ${w >= 1000 ? 'kW' : 'W'}` : s;
}
export const fmtRs = (x, d = 2) => (x == null ? '–' : `₹${Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
export const fmtKwh = x => (x == null ? '–' : `${x < 10 ? x.toFixed(2) : x.toFixed(1)} kWh`);
export function fmtDur(ms) {
  if (ms == null) return '–';
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDateTime(ts);
}
export const bandLabel = b => ({ peak: 'Peak rate', offpeak: 'Off-peak rate', normal: 'Normal rate' }[b] || b);

// ---------------------------------------------------------------- appliances
export const appColor = k => `var(--c-${k})`;
export const appInfo = k => state.me?.appliances.find(a => a.key === k) || { key: k, label: k, short: k };

// ---------------------------------------------------------------- icons (24px line icons)
const I = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const icons = {
  home: I('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
  timeline: I('<path d="M4 6h10"/><path d="M8 12h12"/><path d="M4 18h8"/><circle cx="17" cy="6" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="15" cy="18" r="1.4"/>'),
  usage: I('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  bell: I('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  meter: I('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 15a5 5 0 0 1 10 0"/><path d="m12 15 2.5-3"/>'),
  users: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18.5 14a6.5 6.5 0 0 1 3 6"/>'),
  brain: I('<path d="M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 13a3 3 0 0 0 2 5 3 3 0 0 0 6 0V5a1 1 0 0 0-1-1z"/><path d="M15 4a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 5.5 3 3 0 0 1-2 5 3 3 0 0 1-6 0"/>'),
  tag: I('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>'),
  code: I('<path d="m8 6-6 6 6 6"/><path d="m16 6 6 6-6 6"/>'),
  download: I('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  logout: I('<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>'),
  bolt: I('<path d="M13 2 4.5 14H11l-1 8L19.5 10H13z"/>'),
  leaf: I('<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19 14 10"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  alert: I('<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/>'),
  chevL: I('<path d="m15 18-6-6 6-6"/>'),
  chevR: I('<path d="m9 18 6-6-6-6"/>'),
  plus: I('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  x: I('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  pause: I('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  play: I('<path d="M7 4v16l13-8z"/>'),
  more: I('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  // appliances
  dryer: I('<path d="M14 8a5 5 0 1 0-4 8.9"/><circle cx="9" cy="8" r="2"/><path d="M10 13.5 13 21h3l-2.3-7.3"/><path d="M15 6h3"/><path d="M15 9h5"/><path d="M15 12h3"/>'),
  straightener: I('<path d="M8 2.5 6 21"/><path d="M16 2.5 18 21"/><path d="M8 2.5h8"/><path d="M7.2 10h1.6"/><path d="M15.2 10h1.6"/><path d="M12 2.5V6"/>'),
  b200: I('<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.7.5 1 1.3 1 2.1h5c0-.8.3-1.6 1-2.1A6 6 0 0 0 12 3z"/><path d="M12 7v3"/>'),
  b100: I('<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.7.5 1 1.3 1 2.1h5c0-.8.3-1.6 1-2.1A6 6 0 0 0 12 3z"/>'),
};
export const logo = `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M13.6 2 5 14.6h6.2L9.9 22 19 9.2h-6.3z" fill="#ff7a2f"/></svg>`;

// ---------------------------------------------------------------- toasts and modal
export function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 4200);
}

/** Opens a modal with the given inner HTML; resolves with the form data on submit, or null on cancel. */
export function modal(html, { onMount } = {}) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<form class="modal" novalidate>${html}</form>`;
    document.body.append(back);
    const form = back.querySelector('form');
    const close = v => { back.remove(); resolve(v); };
    back.addEventListener('mousedown', e => { if (e.target === back) close(null); });
    form.addEventListener('click', e => { if (e.target.closest('[data-cancel]')) { e.preventDefault(); close(null); } });
    form.addEventListener('submit', e => { e.preventDefault(); close(Object.fromEntries(new FormData(form))); });
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', k); close(null); } });
    onMount?.(form);
    form.querySelector('input, select, textarea')?.focus();
  });
}
export async function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  const r = await modal(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
    <div class="modal-actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(okLabel)}</button></div>`);
  return r !== null;
}
export function download(url) { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.append(a); a.click(); a.remove(); }
