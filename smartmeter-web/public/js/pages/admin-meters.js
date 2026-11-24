// Admin: every meter with its health, and who it belongs to.
import { api, on } from '../api.js';
import { state, esc, $, icons, toast, modal, ago, fmtW, fmtDur } from '../ui.js';

export async function render(root, { refreshMeters }) {
  let data = null, users = [];
  root.innerHTML = `
    <div class="page-head"><div><h1>Fleet</h1><p id="mq" class="muted"></p></div>
      <div class="actions"><button class="btn" id="add">${icons.plus} Add meter</button></div></div>
    <div class="grid g-4" id="kpis"></div>
    <section class="card mt"><div class="table-wrap"><table class="t">
      <thead><tr><th>Meter</th><th>Status</th><th>Last seen</th><th class="r">Power</th><th class="r">Signal</th><th class="r">Free heap</th><th class="r">Msgs/min</th><th class="r">Uptime</th><th>User</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div></section>`;

  const rssiText = r => r == null ? '–' : `<span class="${r < -80 ? 'bad-text' : r < -70 ? 'warn-text' : ''}">${r} dBm</span>`;
  const paint = () => {
    const ms = data.meters, online = ms.filter(m => m.status === 'online').length, lowHeap = ms.filter(m => m.heap != null && m.heap < data.heapWarn && m.status === 'online').length;
    $('#mq', root).innerHTML = `MQTT ${data.mqtt.connected ? '<span class="good-text">connected</span>' : '<span class="bad-text">disconnected</span>'} to <span class="mono">${esc(data.mqtt.broker || '–')}</span> · ${data.mqtt.messages.toLocaleString('en-IN')} messages since start`;
    $('#kpis', root).innerHTML = `
      <div class="card"><div class="label">Meters online</div><div class="stat num mt-s">${online}<small>of ${ms.length}</small></div></div>
      <div class="card"><div class="label">Low memory warnings</div><div class="stat num mt-s ${lowHeap ? 'warn-text' : ''}">${lowHeap}</div><div class="muted mt-s">heap below ${data.heapWarn} bytes</div></div>
      <div class="card"><div class="label">Users</div><div class="stat num mt-s">${data.users}</div></div>
      <div class="card"><div class="label">Unread alerts</div><div class="stat num mt-s">${data.unreadAlerts}</div></div>`;
    $('#rows', root).innerHTML = ms.length ? ms.map(m => `
      <tr>
        <td><div style="font-weight:600">${esc(m.name || m.deviceId)}</div><div class="mono faint">${esc(m.deviceId)}</div></td>
        <td><span class="row" style="gap:7px"><span class="dot ${m.status === 'online' ? 'online' : m.status === 'offline' ? 'offline' : ''}"></span>${m.status === 'never' ? 'No data yet' : m.status === 'online' ? 'Online' : 'Offline'}</span></td>
        <td class="num">${ago(m.lastSeen)}</td>
        <td class="r num">${m.status === 'online' ? fmtW(m.power) : '–'}</td>
        <td class="r num">${rssiText(m.rssi)}</td>
        <td class="r num">${m.heap == null ? '–' : `<span class="${m.heap < data.heapWarn ? 'warn-text' : ''}">${m.heap.toLocaleString('en-IN')}${m.heap < data.heapWarn ? ' ⚠' : ''}</span>`}</td>
        <td class="r num">${m.msgsPerMin}</td>
        <td class="r num">${m.uptime != null ? fmtDur(m.uptime * 1000) : '–'}${m.reboots ? `<div class="faint" style="font-size:11.5px">${m.reboots} restart${m.reboots > 1 ? 's' : ''}</div>` : ''}</td>
        <td>${m.user ? `${esc(m.user.name)}<div class="faint" style="font-size:12px">${esc(m.user.email)}</div>` : '<span class="faint">Unassigned</span>'}</td>
        <td class="r"><button class="btn sm" data-edit="${esc(m.deviceId)}">Edit</button></td>
      </tr>`).join('') : '<tr><td colspan="10" class="empty">No meters yet. They appear automatically when they publish data.</td></tr>';
  };
  const load = async () => { [data, users] = await Promise.all([api('/api/admin/overview'), api('/api/admin/users')]); paint(); };

  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-edit]'); if (!b) return;
    const m = data.meters.find(x => x.deviceId === b.dataset.edit);
    const r = await modal(`<h2>Edit meter</h2>
      <p class="mono faint" style="margin:-8px 0 14px">${esc(m.deviceId)}</p>
      <label class="field"><span>Name</span><input class="input" name="name" value="${esc(m.name || '')}"></label>
      <label class="field mt"><span>Assigned to</span><select class="input" name="userId"><option value="">Nobody</option>${users.map(u => `<option value="${u.id}" ${m.user?.id === u.id ? 'selected' : ''}>${esc(u.name)} (${esc(u.email)})</option>`).join('')}</select></label>
      <div class="modal-actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Save</button></div>`);
    if (!r) return;
    try { await api(`/api/admin/meters/${encodeURIComponent(m.deviceId)}`, { method: 'PUT', body: { name: r.name, userId: r.userId || null } }); toast('Meter saved', 'good'); await load(); refreshMeters(); }
    catch (err) { toast(err.message, 'bad'); }
  });
  $('#add', root).addEventListener('click', async () => {
    const r = await modal(`<h2>Add a meter</h2><p class="muted" style="margin-top:-6px">Meters also appear by themselves when they publish to <span class="mono">btp/meter/&lt;id&gt;/data</span>.</p>
      <label class="field"><span>Device ID</span><input class="input mono" name="deviceId" placeholder="pm33-xxxxxxxx" required></label>
      <label class="field mt"><span>Name</span><input class="input" name="name" placeholder="Kitchen meter"></label>
      <label class="field mt"><span>Assign to</span><select class="input" name="userId"><option value="">Nobody</option>${users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
      <div class="modal-actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn primary">Add meter</button></div>`);
    if (!r) return;
    try { await api('/api/admin/meters', { method: 'POST', body: { deviceId: r.deviceId, name: r.name, userId: r.userId ? Number(r.userId) : null } }); toast('Meter added', 'good'); await load(); refreshMeters(); }
    catch (err) { toast(err.message, 'bad'); }
  });

  await load();
  const t = setInterval(load, 10_000);
  const unsub = on('status', () => load());
  return () => { clearInterval(t); unsub(); };
}
