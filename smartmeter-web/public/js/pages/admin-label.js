// Admin: label raw 1-second readings with the true appliance states, export CSV for retraining.
import { api } from '../api.js';
import { state, esc, $, $$, icons, toast, fmtTime, fmtTimeS, fmtDateTime, fmtDur, appColor, appInfo, download, confirmBox } from '../ui.js';
import { powerChart, segmentsFrom } from '../charts.js';

const KEYS = ['dryer', 'straightener', 'b200', 'b100'];
const WINDOWS = { '15 min': 15 * 60e3, '1 h': 3600e3, '3 h': 3 * 3600e3, '6 h': 6 * 3600e3 };

export async function render(root) {
  const meters = state.meters;
  let id = state.meterId || meters[0]?.deviceId, win = 3600e3, end = Date.now(), data = null, sel = null, chart = null;

  root.innerHTML = `
    <div class="page-head"><div><h1>Labelling</h1><p>Drag across the chart to select a period, tick the appliances that were really on, and save. Exports feed the next model training.</p></div>
      <div class="actions"><select class="input" id="meter" style="width:220px">${meters.map(m => `<option value="${esc(m.deviceId)}">${esc(m.name)}</option>`).join('')}</select></div></div>
    <section class="card">
      <div class="card-head">
        <h2 id="win-title"></h2>
        <div class="seg" id="win">${Object.entries(WINDOWS).map(([k, v]) => `<button data-w="${v}" class="${v === win ? 'on' : ''}">${k}</button>`).join('')}</div>
        <button class="btn sm" id="back">${icons.chevL} Earlier</button><button class="btn sm" id="fwd">Later ${icons.chevR}</button><button class="btn sm" id="now">Now</button>
      </div>
      <div class="chart" id="chart"></div>
      <div class="legend mt-s"><span>Lanes show what the <b>model</b> detected</span><span><i class="swatch" style="--c:#7fb2ff"></i>Dashed boxes are your saved labels</span><span class="faint" id="oldest"></span></div>
    </section>
    <div class="grid g-main mt">
      <section class="card">
        <div class="card-head"><h2>Label the selection</h2><span class="sub" id="sel-text">Nothing selected</span></div>
        <div class="row" id="checks">${KEYS.map(k => `<label class="check" style="margin-right:12px"><input type="checkbox" data-k="${k}"> <i class="swatch" style="--c:${appColor(k)}"></i>${esc(appInfo(k).label)}</label>`).join('')}</div>
        <div class="row mt"><input class="input" id="note" placeholder="Note (optional), e.g. 'dryer on low setting'" style="flex:1;min-width:200px">
          <button class="btn" id="from-model">Copy model's answer</button><button class="btn primary" id="save">Save label</button></div>
        <p class="faint mt" style="font-size:13px">Tip: label stretches where nothing changes. Leave the seconds around a switch out unless you are sure of the timing.</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>Export for training</h2></div>
        <p class="muted" style="margin:0 0 12px;font-size:13.5px">Columns: <span class="mono">voltage_V, current_A, power_W, pf, hair_dryer, hair_straightener, bulb_200W, bulb_100W</span> · one row per second in the window shown.</p>
        <label class="check"><input type="radio" name="mode" value="labelled" checked> Only my labelled seconds</label>
        <label class="check mt-s"><input type="radio" name="mode" value="model"> Labelled seconds, plus the model's answer elsewhere (not while deciding)</label>
        <label class="check mt-s"><input type="checkbox" id="with-ts"> Add a timestamp column</label>
        <button class="btn mt" id="export">${icons.download} Download CSV</button>
      </section>
    </div>
    <section class="card mt"><div class="card-head"><h2>Saved labels in this window</h2></div><div class="list" id="labels"></div></section>`;
  $('#meter', root).value = id || '';

  async function load() {
    if (!id) return;
    const from = end - win;
    data = await api(`/api/admin/label/${encodeURIComponent(id)}?from=${Math.round(from)}&to=${Math.round(end)}`);
    $('#win-title', root).textContent = `${fmtDateTime(from)} – ${fmtTime(end)}`;
    $('#oldest', root).textContent = data.oldestRaw ? `Raw readings kept since ${fmtDateTime(data.oldestRaw)}` : 'No raw readings stored for this meter yet';
    draw();
    paintLabels();
  }
  function draw() {
    const s = data.samples;
    const lanes = KEYS.map(k => ({ key: k, segs: segmentsFrom(s, k, 1000, r => Number(r.app?.[k])) }));
    const opts = { from: data.from, to: data.to, points: s.map(r => ({ ts: r.ts, p: r.p })), lanes, stepMs: 1000,
      marks: data.labels.map(l => ({ t0: l.start_ts, t1: l.end_ts, label: KEYS.filter(k => l[k]).map(k => appInfo(k).short).join(' + ') || 'All off' })),
      brush: (a, b) => { sel = [a, b]; paintSel(); }, selection: sel };
    if (chart) chart.redraw(opts); else chart = powerChart($('#chart', root), opts);
  }
  function paintSel() {
    if (!sel) { $('#sel-text', root).textContent = 'Nothing selected'; return; }
    const n = data.samples.filter(r => r.ts >= sel[0] && r.ts < sel[1]).length;
    $('#sel-text', root).textContent = `${fmtTimeS(sel[0])} – ${fmtTimeS(sel[1])} · ${fmtDur(sel[1] - sel[0])} · ${n} readings`;
  }
  function paintLabels() {
    $('#labels', root).innerHTML = data.labels.length ? data.labels.map(l => `
      <div class="li"><div class="grow"><div class="t1">${KEYS.filter(k => l[k]).map(k => esc(appInfo(k).label)).join(' + ') || 'All off'}</div>
      <div class="t2">${fmtTimeS(l.start_ts)} – ${fmtTimeS(l.end_ts)} · ${fmtDur(l.end_ts - l.start_ts)}${l.note ? ` · ${esc(l.note)}` : ''}</div></div>
      <button class="btn ghost sm danger" data-del="${l.id}">Delete</button></div>`).join('') : '<div class="empty">No labels in this window yet</div>';
  }

  $('#from-model', root).addEventListener('click', () => {
    if (!sel) return toast('Select a period on the chart first', 'bad');
    const inSel = data.samples.filter(r => r.ts >= sel[0] && r.ts < sel[1] && !r.deciding);
    for (const k of KEYS) $(`[data-k="${k}"]`, root).checked = inSel.length > 0 && inSel.filter(r => Number(r.app?.[k]) === 1).length / inSel.length >= 0.5;
  });
  $('#save', root).addEventListener('click', async () => {
    if (!sel) return toast('Select a period on the chart first', 'bad');
    const body = { device_id: id, start_ts: sel[0], end_ts: sel[1], note: $('#note', root).value, ...Object.fromEntries(KEYS.map(k => [k, $(`[data-k="${k}"]`, root).checked])) };
    try { await api('/api/admin/labels', { method: 'POST', body }); toast('Label saved', 'good'); sel = null; $('#note', root).value = ''; paintSel(); load(); }
    catch (err) { toast(err.message, 'bad'); }
  });
  root.addEventListener('click', async e => {
    const d = e.target.closest('[data-del]');
    if (d && await confirmBox('Delete label?', 'This removes the label, not the readings.', 'Delete', true)) { await api(`/api/admin/labels/${d.dataset.del}`, { method: 'DELETE' }); load(); }
  });
  $('#export', root).addEventListener('click', () => {
    const mode = $$('input[name=mode]', root).find(r => r.checked).value;
    download(`/api/admin/label/${encodeURIComponent(id)}/export.csv?from=${Math.round(end - win)}&to=${Math.round(end)}&mode=${mode}${$('#with-ts', root).checked ? '&ts=1' : ''}`);
  });
  $('#win', root).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; win = Number(b.dataset.w); sel = null; $('#win', root).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); load(); });
  $('#back', root).addEventListener('click', () => { end -= win * 0.75; sel = null; load(); });
  $('#fwd', root).addEventListener('click', () => { end = Math.min(Date.now(), end + win * 0.75); sel = null; load(); });
  $('#now', root).addEventListener('click', () => { end = Date.now(); sel = null; load(); });
  $('#meter', root).addEventListener('change', e => { id = e.target.value; sel = null; load(); });
  await load();
  return () => chart?.destroy();
}
