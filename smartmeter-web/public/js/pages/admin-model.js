// Admin: how the on-chip model is behaving.
import { api } from '../api.js';
import { state, esc, $, icons, fmtW, fmtDateTime, appColor, appInfo } from '../ui.js';
import { powerChart } from '../charts.js';

export async function render(root) {
  let hours = 24, chart = null;
  const meters = state.meters;
  let id = state.meterId || meters[0]?.deviceId;
  root.innerHTML = `
    <div class="page-head"><div><h1>Model monitor</h1><p>The model runs on the meter. These numbers check its decisions against the measured power.</p></div>
      <div class="actions"><select class="input" id="meter" style="width:220px">${meters.map(m => `<option value="${esc(m.deviceId)}">${esc(m.name)}</option>`).join('')}</select>
      <div class="seg" id="hours">${[6, 24, 168, 720].map(h => `<button data-h="${h}" class="${h === hours ? 'on' : ''}">${h < 48 ? `${h} h` : `${h / 24} d`}</button>`).join('')}</div></div></div>
    <div class="grid g-4" id="kpis"></div>
    <div class="grid g-main mt">
      <section class="card"><div class="card-head"><h2>Measured vs expected power</h2><span class="sub">Expected = sum of the typical power of the appliances the model says are ON</span></div>
        <div class="chart" id="chart"></div>
        <div class="legend mt-s"><span><i class="swatch" style="--c:#ff7a2f"></i>Measured (1-min average)</span><span><i class="swatch" style="--c:#c7c7cf"></i>Expected from detected appliances</span></div></section>
      <section class="card"><div class="card-head"><h2>Switches per appliance</h2></div><div id="per"></div></section>
    </div>
    <section class="card mt"><div class="card-head"><h2>Largest mismatches</h2><span class="sub">Minutes where measured and expected power differ most (not while deciding)</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Time</th><th class="r">Measured</th><th class="r">Expected</th><th class="r">Difference</th><th>Likely cause</th></tr></thead><tbody id="worst"></tbody></table></div></section>`;
  $('#meter', root).value = id || '';

  const cause = d => d > 900 ? 'Dryer on but not detected' : d < -900 ? 'Dryer detected but off' : d > 180 ? 'A bulb missed, or two switches at once' : d < -180 ? 'A bulb detected but off'
    : d > 0 ? 'Straightener warming up / small appliance missed' : 'Straightener cooler than typical, or wrong appliance';
  async function load() {
    if (!id) { root.querySelector('#kpis').innerHTML = '<div class="card empty">No meters</div>'; return; }
    const d = await api(`/api/admin/model/${encodeURIComponent(id)}?hours=${hours}`);
    const pct = x => (x == null ? '–' : `${(x * 100).toFixed(1)}%`);
    $('#kpis', root).innerHTML = `
      <div class="card"><div class="label">Switches detected</div><div class="stat num mt-s">${d.events}</div><div class="muted mt-s">${d.flicker} reverted within 30 s</div></div>
      <div class="card"><div class="label">Time spent deciding</div><div class="stat num mt-s">${pct(d.decidingShare)}</div><div class="muted mt-s">${d.decidingSamples.toLocaleString('en-IN')} of ${d.samples.toLocaleString('en-IN')} readings</div></div>
      <div class="card"><div class="label">Mismatch minutes</div><div class="stat num mt-s ${d.minutes && d.mismatchMinutes / d.minutes > 0.05 ? 'warn-text' : ''}">${d.mismatchMinutes}</div><div class="muted mt-s">${pct(d.minutes ? d.mismatchMinutes / d.minutes : null)} of ${d.minutes} min, |diff| > ${d.mismatchW} W</div></div>
      <div class="card"><div class="label">Mean absolute difference</div><div class="stat num mt-s">${d.meanAbsResidualW == null ? '–' : `${d.meanAbsResidualW}<small>W</small>`}</div><div class="muted mt-s">Lower is better</div></div>`;
    const max = Math.max(1, ...d.perApp.map(a => a.on + a.off));
    $('#per', root).innerHTML = d.perApp.map(a => `
      <div class="li" style="--c:${appColor(a.appliance)}"><i class="swatch"></i><div class="grow"><div class="t1">${esc(appInfo(a.appliance).label)}</div>
      <div class="appl-bar mt-s"><span style="width:${((a.on + a.off) / max) * 100}%"></span></div></div>
      <div class="num" style="text-align:right;font-size:13px"><b>${a.on}</b> on<br><b>${a.off}</b> off</div></div>`).join('');
    const opts = { from: Date.now() - hours * 3600e3, to: Date.now(), points: d.series.map(r => ({ ts: r.ts + 30e3, p: r.p })), second: d.series.map(r => ({ ts: r.ts + 30e3, p: r.expected })), lanes: [], stepMs: 60e3 };
    if (chart) chart.redraw(opts); else chart = powerChart($('#chart', root), opts);
    $('#worst', root).innerHTML = d.worst.length ? d.worst.map(w => `<tr><td class="num">${fmtDateTime(w.ts)}</td><td class="r num">${fmtW(w.p)}</td><td class="r num">${fmtW(w.expected)}</td>
      <td class="r num ${Math.abs(w.diff) > 300 ? 'bad-text' : 'warn-text'}">${w.diff > 0 ? '+' : ''}${Math.round(w.diff)} W</td><td class="muted">${cause(w.diff)}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">No mismatches above the threshold in this period</td></tr>';
  }
  $('#meter', root).addEventListener('change', e => { id = e.target.value; load(); });
  $('#hours', root).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; hours = Number(b.dataset.h); $('#hours', root).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); load(); });
  await load();
  const t = setInterval(load, 60_000);
  return () => { clearInterval(t); chart?.destroy(); };
}
