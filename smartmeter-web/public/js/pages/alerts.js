// Alerts: offline meter, peak-time use, several appliances at once, straightener left on, high power.
import { api, on } from '../api.js';
import { state, esc, $, icons, fmtDateTime, ago } from '../ui.js';

const KIND = {
  offline: { icon: 'alert', name: 'Offline' }, peak_heavy: { icon: 'clock', name: 'Peak use' }, multi: { icon: 'bolt', name: 'Several on' },
  left_on: { icon: 'alert', name: 'Left on' }, high_power: { icon: 'bolt', name: 'High power' }, low_heap: { icon: 'info', name: 'Memory' }, reboot: { icon: 'info', name: 'Restart' },
};

export async function render(root, { setUnread }) {
  let list = [], filter = 'all';
  root.innerHTML = `
    <div class="page-head"><div><h1>Alerts</h1><p>Things worth knowing about your meter and your usage.</p></div>
      <div class="actions"><div class="seg" id="f"><button data-f="all" class="on">All</button><button data-f="unread">Unread</button></div><button class="btn" id="read-all">Mark all as read</button></div></div>
    <section class="card"><div class="list" id="list"></div></section>`;
  const meterName = id => state.meters.find(m => m.deviceId === id)?.name || id;
  const paint = () => {
    const rows = list.filter(a => filter === 'all' || !a.read_at);
    $('#list', root).innerHTML = rows.length ? rows.map(a => `
      <div class="li ${a.read_at ? '' : 'unread'}" data-id="${a.id}">
        <div class="alert-ic ${esc(a.level)}">${icons[KIND[a.kind]?.icon || 'info']}</div>
        <div class="grow"><div class="t1">${esc(a.title)}</div><div class="t2">${esc(a.body || '')}</div>
        <div class="t2 faint">${esc(KIND[a.kind]?.name || a.kind)} · ${esc(meterName(a.device_id))} · ${fmtDateTime(a.ts)} (${ago(a.ts)})${a.admin_only ? ' · admin only' : ''}</div></div>
        ${a.read_at ? '' : `<button class="btn ghost sm" data-read="${a.id}">Mark read</button>`}
      </div>`).join('') : `<div class="empty">${filter === 'unread' ? 'You are all caught up.' : 'No alerts yet.'}</div>`;
    setUnread(list.filter(a => !a.read_at).length);
  };
  const load = async () => { list = await api('/api/alerts?limit=200'); paint(); };
  root.addEventListener('click', async e => {
    const r = e.target.closest('[data-read]');
    if (r) { await api('/api/alerts/read', { method: 'POST', body: { ids: [Number(r.dataset.read)] } }); list.find(a => a.id === Number(r.dataset.read)).read_at = Date.now(); paint(); }
    const f = e.target.closest('[data-f]');
    if (f) { filter = f.dataset.f; $('#f', root).querySelectorAll('button').forEach(b => b.classList.toggle('on', b === f)); paint(); }
  });
  $('#read-all', root).addEventListener('click', async () => { await api('/api/alerts/read', { method: 'POST', body: { all: true } }); list.forEach(a => (a.read_at ||= Date.now())); paint(); });
  const unsub = on('alert', () => load());
  await load();
  return unsub;
}
