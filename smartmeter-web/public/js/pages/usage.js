// Usage and cost: kWh and rupees per day for a month, and where the money goes.
import { api } from '../api.js';
import { state, esc, $, icons, fmtRs, fmtKwh, fmtDur, fmtMonth, fmtDate, dayStart, appColor, appInfo, download } from '../ui.js';
import { barChart } from '../charts.js';

export async function render(root) {
  const id = state.meterId;
  if (!id) { root.innerHTML = '<div class="card empty">No meter assigned.</div>'; return; }
  const now = new Date(Date.now() + 330 * 60e3);
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1, chart = null, metric = 'cost';

  root.innerHTML = `
    <div class="page-head">
      <div><h1 id="m-title"></h1><p>Measured by the meter's energy counter, priced with your time-of-day tariff.</p></div>
      <div class="actions">
        <button class="btn" id="prev">${icons.chevL}</button><button class="btn" id="next">${icons.chevR}</button>
        <button class="btn" id="csv">${icons.download} Month CSV</button>
      </div>
    </div>
    <div class="grid g-4" id="kpis"></div>
    <section class="card mt">
      <div class="card-head"><h2>Per day</h2><div class="seg" id="metric"><button data-m="cost" class="on">₹ Cost</button><button data-m="kwh">kWh</button></div></div>
      <div class="chart" id="bars"></div>
    </section>
    <section class="card mt"><div class="card-head"><h2>Where the money goes</h2><span class="sub">Estimated from detected run times and typical power</span></div><div id="breakdown"></div></section>`;

  async function load() {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const d = await api(`/api/meters/${encodeURIComponent(id)}/daily?month=${key}`);
    const runs = await api(`/api/meters/${encodeURIComponent(id)}/runs?from=${d.start}&to=${Math.min(d.end, Date.now())}`);
    $('#m-title', root).textContent = fmtMonth(d.start + 86400e3);
    const isCurrent = d.end > Date.now() && d.start <= Date.now();
    $('#next', root).disabled = isCurrent;
    const kwh = d.days.reduce((s, x) => s + x.kwh, 0), cost = d.days.reduce((s, x) => s + x.cost, 0);
    const used = d.days.filter(x => x.kwh > 0);
    const best = used.length ? used.reduce((a, b) => (b.cost > a.cost ? b : a)) : null;
    $('#kpis', root).innerHTML = `
      <div class="card"><div class="label">Energy</div><div class="stat num mt-s">${kwh.toFixed(1)}<small>kWh</small></div></div>
      <div class="card"><div class="label">Cost</div><div class="stat num mt-s">${fmtRs(cost, 0)}</div></div>
      <div class="card"><div class="label">Average per day</div><div class="stat num mt-s">${fmtRs(used.length ? cost / used.length : 0)}</div><div class="muted mt-s">${used.length} day${used.length === 1 ? '' : 's'} with data</div></div>
      <div class="card"><div class="label">Most expensive day</div><div class="stat num mt-s">${best ? fmtRs(best.cost) : '–'}</div><div class="muted mt-s">${best ? fmtDate(best.day) : ''}</div></div>`;
    const today = dayStart(Date.now());
    chart?.destroy();
    chart = barChart($('#bars', root), {
      bars: d.days.map(x => ({ label: String(new Date(x.day + 330 * 60e3).getUTCDate()), value: metric === 'cost' ? x.cost : x.kwh, accent: x.day === today,
        title: `${fmtDate(x.day)}: ${x.kwh.toFixed(2)} kWh · ${fmtRs(x.cost)}` })),
      unit: metric === 'cost' ? '₹' : 'kWh',
    });
    const total = runs.byApp.reduce((s, a) => s + a.costEst, 0) || 1;
    const rest = Math.max(0, runs.total.cost - runs.byApp.reduce((s, a) => s + a.costEst, 0));
    $('#breakdown', root).innerHTML = runs.byApp.sort((a, b) => b.costEst - a.costEst).map(a => `
      <div class="li" style="--c:${appColor(a.appliance)}">
        <i class="swatch"></i><div class="grow"><div class="t1">${esc(appInfo(a.appliance).label)}</div>
        <div class="appl-bar mt-s" style="--c:${appColor(a.appliance)}"><span style="width:${(a.costEst / total) * 100}%"></span></div>
        <div class="t2 mt-s">${a.runs} runs · ${fmtDur(a.minutes * 60e3)} · ${a.kwhEst.toFixed(2)} kWh</div></div>
        <div class="stat num" style="font-size:17px">${fmtRs(a.costEst)}</div></div>`).join('')
      + `<div class="li"><i class="swatch" style="--c:var(--text-3)"></i><div class="grow"><div class="t1">Other and standby</div><div class="t2">Measured cost not explained by the four appliances</div></div><div class="stat num muted" style="font-size:17px">${fmtRs(rest)}</div></div>`;
    root._range = d;
  }
  $('#prev', root).addEventListener('click', () => { m--; if (m < 1) { m = 12; y--; } load(); });
  $('#next', root).addEventListener('click', () => { m++; if (m > 12) { m = 1; y++; } load(); });
  $('#metric', root).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; metric = b.dataset.m; $('#metric', root).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); load(); });
  $('#csv', root).addEventListener('click', () => { const r = root._range; if (r) download(`/api/meters/${encodeURIComponent(id)}/export.csv?kind=minutes&from=${r.start}&to=${r.end}`); });
  await load();
  return () => chart?.destroy();
}
