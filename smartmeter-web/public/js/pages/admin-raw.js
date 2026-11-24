// Admin: the raw MQTT messages as they arrive.
import { api, on } from '../api.js';
import { state, esc, $, icons, fmtTimeS, fmtDateTime } from '../ui.js';

export async function render(root) {
  let rows = [], paused = false, device = '', picked = null;
  root.innerHTML = `
    <div class="page-head"><div><h1>Raw messages</h1><p>Every data message, stamped with the server's arrival time.</p></div>
      <div class="actions"><select class="input" id="dev" style="width:220px"><option value="">All meters</option>${state.meters.map(m => `<option value="${esc(m.deviceId)}">${esc(m.deviceId)}</option>`).join('')}</select>
      <button class="btn" id="pause">${icons.pause} Pause</button></div></div>
    <div class="grid g-main">
      <section class="card"><div class="table-wrap"><table class="t mono" style="font-size:12.5px">
        <thead><tr><th>Arrived</th><th>Device</th><th class="r">seq</th><th class="r">P (W)</th><th class="r">V</th><th class="r">I (A)</th><th class="r">PF</th><th>app d/s/2/1</th><th class="r">dec</th><th class="r">rssi</th><th class="r">heap</th></tr></thead>
        <tbody id="rows"></tbody></table></div></section>
      <section class="card" style="align-self:start;position:sticky;top:80px"><div class="card-head"><h2>Message</h2><span class="sub" id="pick-meta">Click a row</span></div><pre class="json" id="json">{}</pre></section>
    </div>`;
  const appStr = a => a ? ['dryer', 'straightener', 'b200', 'b100'].map(k => (Number(a[k]) ? '<b style="color:var(--accent)">1</b>' : '<span class="faint">0</span>')).join(' ') : '–';
  const paint = () => {
    $('#rows', root).innerHTML = rows.slice(0, 200).map((r, i) => `
      <tr data-i="${i}" style="cursor:pointer"><td>${fmtTimeS(r.ts)}</td><td>${esc(r.device)}</td><td class="r">${r.msg.seq ?? '–'}</td><td class="r">${r.msg.p?.toFixed?.(1) ?? '–'}</td>
      <td class="r">${r.msg.v?.toFixed?.(1) ?? '–'}</td><td class="r">${r.msg.i?.toFixed?.(3) ?? '–'}</td><td class="r">${r.msg.pf?.toFixed?.(3) ?? '–'}</td><td>${appStr(r.msg.app)}</td>
      <td class="r">${r.msg.deciding ? '<span class="warn-text">1</span>' : '0'}</td><td class="r">${r.msg.rssi ?? '–'}</td><td class="r ${r.msg.heap < state.me.heapWarn ? 'warn-text' : ''}">${r.msg.heap ?? '–'}</td></tr>`).join('')
      || '<tr><td colspan="11" class="empty" style="font-family:var(--font)">Waiting for messages…</td></tr>';
  };
  const load = async () => { rows = await api(`/api/admin/raw?limit=200${device ? `&device=${encodeURIComponent(device)}` : ''}`); paint(); };
  $('#rows', root).addEventListener('click', e => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    picked = rows[Number(tr.dataset.i)];
    $('#json', root).textContent = JSON.stringify(picked.msg, null, 2);
    $('#pick-meta', root).textContent = `${picked.device} · ${fmtDateTime(picked.ts)}:${String(new Date(picked.ts).getUTCSeconds()).padStart(2, '0')}`;
  });
  $('#pause', root).addEventListener('click', e => { paused = !paused; e.currentTarget.innerHTML = paused ? `${icons.play} Resume` : `${icons.pause} Pause`; });
  $('#dev', root).addEventListener('change', e => { device = e.target.value; load(); });
  let pending = false;
  const unsub = on('raw', d => {
    if (paused || (device && d.device !== device)) return;
    rows.unshift({ device: d.device, ts: d.ts, msg: d.msg });
    if (rows.length > 400) rows.length = 400;
    if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; paint(); }); }
  });
  await load();
  return unsub;
}
