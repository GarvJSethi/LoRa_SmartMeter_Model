// Appliance timeline for one day: when each appliance ran, for how long, and what it cost.
import { api, on } from '../api.js';
import { state, esc, $, icons, fmtRs, fmtKwh, fmtDur, fmtTime, fmtDay, isoDay, fromIsoDay, dayStart, appColor, appInfo, download } from '../ui.js';
import { dayTimeline } from '../charts.js';

const KEYS = ['dryer', 'straightener', 'b200', 'b100'];

export async function render(root) {
  const id = state.meterId;
  if (!id) { root.innerHTML = '<div class="card empty">No meter assigned.</div>'; return; }
  let day = dayStart(Date.now()), tl = null;

  root.innerHTML = `
    <div class="page-head">
      <div><h1 id="day-title"></h1><p>Run times are detected by the meter's model; costs use your time-of-day tariff and each appliance's typical power.</p></div>
      <div class="actions">
        <button class="btn" id="prev" aria-label="Previous day">${icons.chevL}</button>
        <input class="input" type="date" id="date" style="width:150px">
        <button class="btn" id="next" aria-label="Next day">${icons.chevR}</button>
      </div>
    </div>
    <div class="grid g-4" id="totals"></div>
    <section class="card mt"><div class="card-head"><h2>Day at a glance</h2><span class="sub" id="tl-sub"></span></div><div class="chart" id="tl"></div></section>
    <section class="card mt">
      <div class="card-head"><h2>Runs</h2>
        <button class="btn sm" data-csv="runs">${icons.download} Runs CSV</button>
        <button class="btn sm" data-csv="events">${icons.download} Switches CSV</button>
        <button class="btn sm" data-csv="minutes">${icons.download} Readings CSV (1-min)</button>
      </div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Appliance</th><th>Started</th><th>Ended</th><th class="r">Duration</th><th class="r">Energy (est.)</th><th class="r">Cost (est.)</th></tr></thead><tbody id="runs"></tbody></table></div>
    </section>`;

  async function load() {
    const now = Date.now(), to = Math.min(day + 86400e3, now);
    $('#day-title', root).textContent = day === dayStart(now) ? 'Today' : fmtDay(day);
    $('#date', root).value = isoDay(day);
    $('#next', root).disabled = day >= dayStart(now);
    if (day > now) return;
    const r = await api(`/api/meters/${encodeURIComponent(id)}/runs?from=${day}&to=${to}`);
    $('#totals', root).innerHTML = `
      <div class="card"><div class="label">Measured energy</div><div class="stat num mt-s">${r.total.kwh.toFixed(2)}<small>kWh</small></div><div class="muted mt-s">${fmtRs(r.total.cost)} with your tariff</div></div>
      ${r.byApp.filter(a => a.appliance !== 'b100').concat(r.byApp.filter(a => a.appliance === 'b100')).slice(0, 3).map(a => `
        <div class="card" style="--c:${appColor(a.appliance)}"><div class="row"><i class="swatch"></i><span class="label">${esc(appInfo(a.appliance).label)}</span></div>
        <div class="stat num mt-s">${a.minutes ? fmtDur(a.minutes * 60e3) : '–'}</div><div class="muted mt-s">${a.runs} run${a.runs === 1 ? '' : 's'} · ${fmtRs(a.costEst)}</div></div>`).join('')}`;
    const lanes = KEYS.map(k => ({ key: k, runs: r.runs.filter(x => x.appliance === k).map(x => ({ s: x.clippedStart, e: x.clippedEnd, open: !x.end,
      label: `${appInfo(k).label}: ${fmtTime(x.clippedStart)}–${x.end ? fmtTime(x.clippedEnd) : 'now'} · ${fmtDur(x.durationMs)} · ${fmtRs(x.costEst)}` })) }));
    tl?.destroy();
    tl = dayTimeline($('#tl', root), { from: day, to: day + 86400e3, lanes, now });
    const b100 = r.byApp.find(a => a.appliance === 'b100');
    $('#tl-sub', root).textContent = `100 W bulb: ${b100.minutes ? fmtDur(b100.minutes * 60e3) : 'not used'}`;
    const rows = [...r.runs].sort((a, b) => b.clippedStart - a.clippedStart);
    $('#runs', root).innerHTML = rows.length ? rows.map(x => `
      <tr><td><span class="row" style="gap:8px"><i class="swatch" style="--c:${appColor(x.appliance)}"></i>${esc(appInfo(x.appliance).label)}</span></td>
      <td class="num">${fmtTime(x.clippedStart)}${x.start < day ? ' <span class="faint">(earlier)</span>' : ''}</td>
      <td class="num">${x.end ? fmtTime(x.clippedEnd) : '<span class="good-text">running</span>'}</td>
      <td class="r num">${fmtDur(x.durationMs)}</td><td class="r num">${x.kwhEst.toFixed(3)} kWh</td><td class="r num">${fmtRs(x.costEst)}</td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">No appliance runs detected on this day</td></tr>`;
  }

  $('#prev', root).addEventListener('click', () => { day -= 86400e3; load(); });
  $('#next', root).addEventListener('click', () => { day = Math.min(day + 86400e3, dayStart(Date.now())); load(); });
  $('#date', root).addEventListener('change', e => { if (e.target.value) { day = fromIsoDay(e.target.value); load(); } });
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-csv]'); if (!b) return;
    download(`/api/meters/${encodeURIComponent(id)}/export.csv?kind=${b.dataset.csv}&from=${day}&to=${day + 86400e3}`);
  });
  const unsub = on('event', d => { if (d.device === id && day === dayStart(Date.now())) load(); });
  await load();
  const t = setInterval(() => { if (day === dayStart(Date.now())) load(); }, 60_000);
  return () => { unsub(); clearInterval(t); tl?.destroy(); };
}
