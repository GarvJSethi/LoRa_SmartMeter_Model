// Overview: what is on now, what it costs, today and this month.
import { api, on } from '../api.js';
import { state, esc, $, icons, fmtW, fmtRs, fmtKwh, fmtDur, fmtTime, fmtTimeS, ago, bandLabel, appColor, appInfo, download } from '../ui.js';
import { powerChart, segmentsFrom } from '../charts.js';

const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
const KEYS = ['dryer', 'straightener', 'b200', 'b100'];

export async function render(root) {
  const id = state.meterId;
  if (!id) { root.innerHTML = `<div class="card empty">No meter is assigned to your account yet. Ask your administrator to assign one.</div>`; return; }
  let sum = null, live = null, range = localStorage.getItem('range') || '6h', series = null, chart = null, livePts = [], events = [];
  const subs = [];

  root.innerHTML = `
    <div class="grid g-3">
      <section class="card hero idle" id="hero">
        <div class="row"><span class="label">Power right now</span><span class="chip hidden" id="detecting"><span class="dot live"></span>Detecting…</span></div>
        <div class="hero-power num" id="power">–</div>
        <div class="hero-meta">
          <span class="chip" id="cost-h"></span>
          <span class="chip" id="band"></span>
          <span class="chip" id="next-band"></span>
        </div>
      </section>
      <section class="card">
        <div class="label">Today</div>
        <div class="stat num mt-s" id="today-kwh">–</div>
        <div class="stat-row"><div><div class="label">Cost so far</div><div class="stat num" id="today-cost">–</div></div></div>
      </section>
      <section class="card">
        <div class="label">This month</div>
        <div class="stat num mt-s" id="month-kwh">–</div>
        <div class="stat-row">
          <div><div class="label">Cost so far</div><div class="stat num" id="month-cost">–</div></div>
          <div><div class="label">On track for</div><div class="stat num muted" id="month-proj">–</div></div>
        </div>
      </section>
    </div>

    <div class="grid g-4 mt" id="appliances">
      ${KEYS.map(k => `
        <section class="card appl" data-k="${k}" style="--c:${appColor(k)}">
          <div class="appl-top"><div class="appl-icon">${icons[k]}</div><div class="appl-name">${esc(appInfo(k).label)}</div><div class="appl-state">Off</div></div>
          <div class="appl-foot"><span class="since">–</span><span class="today"></span></div>
        </section>`).join('')}
    </div>

    <section class="card mt">
      <div class="card-head">
        <h2>Power <span class="sub" style="font-weight:500;color:var(--text-3)">· watts</span></h2>
        <div class="seg" id="range">${Object.keys(RANGES).map(r => `<button data-r="${r}" class="${r === range ? 'on' : ''}">${r}</button>`).join('')}</div>
      </div>
      <div class="chart" id="chart" style="min-height:260px"></div>
      <div class="legend mt-s">${KEYS.map(k => `<span><i class="swatch" style="--c:${appColor(k)}"></i>${esc(appInfo(k).short)}</span>`).join('')}<span class="faint">Bands show when each appliance was detected ON</span></div>
    </section>

    <div class="grid g-main mt">
      <section class="card"><div class="card-head"><h2>Tips</h2><span class="sub">Based on your tariff and what is running</span></div><div id="tips"></div></section>
      <section class="card"><div class="card-head"><h2>Recent switches</h2><a class="btn ghost sm" href="#/timeline">Timeline ${icons.chevR}</a></div><div class="list" id="events"></div></section>
    </div>`;

  // ---------------------------------------------------------------- data
  const loadSummary = async () => {
    sum = await api(`/api/meters/${encodeURIComponent(id)}/summary`);
    live ??= { p: sum.power, confirmed: sum.confirmed, model: sum.model, deciding: sum.deciding, status: sum.status };
    if (sum.status !== 'online') live.p = 0;
    paint();
  };
  const loadSeries = async () => {
    const to = Date.now(), from = to - RANGES[range];
    series = await api(`/api/meters/${encodeURIComponent(id)}/series?from=${from}&to=${to}`);
    livePts = [];
    drawChart();
  };
  const loadEvents = async () => {
    events = await api(`/api/meters/${encodeURIComponent(id)}/events?from=${Date.now() - 2 * 86400e3}`);
    paintEvents();
  };

  // ---------------------------------------------------------------- painting
  function paint() {
    if (!sum) return;
    const p = live.p ?? 0, rate = sum.rate.rate;
    const online = live.status === 'online';
    $('#power', root).innerHTML = online ? `${fmtW(p, { unit: false })}<small>${p >= 1000 ? 'kW' : 'W'}</small>` : `<span class="muted">Offline</span>`;
    $('#hero', root).classList.toggle('idle', !online || p < 50);
    $('#cost-h', root).innerHTML = `${icons.bolt.replace('<svg', '<svg width="14" height="14"')} <span class="num">${fmtRs((p / 1000) * rate)}</span> per hour`;
    const band = $('#band', root);
    band.className = `chip ${sum.rate.band}`;
    band.innerHTML = `${bandLabel(sum.rate.band)} · <span class="num">${fmtRs(rate)}</span>/kWh`;
    const nb = $('#next-band', root);
    if (sum.rate.next) { nb.classList.remove('hidden'); nb.innerHTML = `${icons.clock.replace('<svg', '<svg width="14" height="14"')} ${bandLabel(sum.rate.next.band).replace(' rate', '')} from ${fmtTime(sum.rate.next.ts)}`; }
    else nb.classList.add('hidden');
    $('#detecting', root).classList.toggle('hidden', !live.deciding);
    $('#today-kwh', root).innerHTML = `${sum.today.kwh.toFixed(2)}<small>kWh</small>`;
    $('#today-cost', root).textContent = fmtRs(sum.today.cost);
    $('#month-kwh', root).innerHTML = `${sum.month.kwh.toFixed(1)}<small>kWh</small>`;
    $('#month-cost', root).textContent = fmtRs(sum.month.cost, 0);
    $('#month-proj', root).textContent = fmtRs(sum.month.projectedCost, 0);

    for (const k of KEYS) {
      const card = $(`.appl[data-k="${k}"]`, root);
      const on = !!live.confirmed?.[k];
      const detecting = live.deciding && live.model && !!live.model[k] !== on;
      card.classList.toggle('on', on && !detecting);
      card.classList.toggle('detecting', !!detecting);
      $('.appl-state', card).textContent = detecting ? 'Detecting' : on ? 'On' : 'Off';
      const since = sum.onSince?.[k];
      $('.since', card).innerHTML = !online ? '<span class="faint">No data</span>'
        : on && since ? `On for <b>${fmtDur(Date.now() - since)}</b>` : detecting ? 'Confirming the switch' : '<span class="faint">Idle</span>';
      const t = sum.perAppToday?.[k];
      $('.today', card).innerHTML = t && t.minutes ? `Today ${fmtDur(t.minutes * 60e3)} · <b>${fmtRs(t.costEst)}</b>` : '<span class="faint">Not used today</span>';
    }
    paintTips();
  }

  function paintTips() {
    const t = sum.tariff, rate = sum.rate.rate, band = sum.rate.band;
    const offRate = t.base * (1 - t.offPeakPct / 100);
    const onKeys = KEYS.filter(k => live.confirmed?.[k]);
    const tips = [];
    const offStart = t.offPeak[0]?.start;
    for (const k of ['dryer', 'straightener']) {
      if (!onKeys.includes(k) || band !== 'peak') continue;
      const w = appInfo(k).typicalW, perH = (w / 1000) * rate, perHOff = (w / 1000) * offRate;
      tips.push({ icon: 'clock', title: `${appInfo(k).label} is running at peak rate`,
        body: `About ${fmtRs(perH)} per hour now, against ${fmtRs(perHOff)} in off-peak hours${offStart ? ` (from ${offStart})` : ''}. Saving ${Math.round((1 - perHOff / perH) * 100)}% when you can shift it.` });
    }
    if (onKeys.length >= 2) {
      const total = onKeys.reduce((s, k) => s + appInfo(k).typicalW, 0);
      tips.push({ icon: 'bolt', title: `${onKeys.length} appliances on together`,
        body: onKeys.length >= 3 ? `About ${fmtW(total)} at once. Running them one after another keeps the load lower and avoids tripping a shared socket.`
          : `${onKeys.map(k => appInfo(k).short).join(' and ')} are both on (${fmtW(total)}). Switch one off when you no longer need it.` });
    }
    if (onKeys.includes('straightener') && sum.onSince?.straightener && Date.now() - sum.onSince.straightener > 30 * 60e3) {
      tips.push({ icon: 'alert', title: 'Straightener on for a while', body: `It has been on for ${fmtDur(Date.now() - sum.onSince.straightener)}. Switch it off if you are done.` });
    }
    if (band === 'normal' && sum.rate.next?.band === 'peak' && sum.rate.next.ts - Date.now() < 90 * 60e3) {
      tips.push({ icon: 'clock', title: `Peak rate starts at ${fmtTime(sum.rate.next.ts)}`, body: `Prices go up ${t.peakPct}%. Finish dryer and straightener use before then.` });
    }
    if (band === 'offpeak') tips.push({ icon: 'leaf', title: 'Off-peak hours now', body: `Electricity is ${t.offPeakPct}% cheaper (${fmtRs(rate)}/kWh). A good time for the dryer.` });
    if (!tips.length) tips.push({ icon: 'leaf', title: `${fmtRs(sum.today.cost)} spent today`, body: `At this pace the month ends near ${fmtRs(sum.month.projectedCost, 0)}. Peak hours are ${t.peak.map(w => `${w.start}–${w.end}`).join(' and ')}.` });
    $('#tips', root).innerHTML = tips.slice(0, 3).map(x => `<div class="tip"><div class="tip-ic">${icons[x.icon]}</div><div><b>${esc(x.title)}</b><p>${esc(x.body)}</p></div></div>`).join('');
  }

  function paintEvents() {
    const box = $('#events', root);
    if (!events.length) { box.innerHTML = '<div class="empty">No switches in the last two days</div>'; return; }
    box.innerHTML = events.slice(0, 7).map(e => `
      <div class="li"><i class="swatch" style="--c:${appColor(e.appliance)}"></i>
        <div class="grow"><div class="t1">${esc(appInfo(e.appliance).label)} switched ${e.state ? 'on' : 'off'}</div>
        <div class="t2">${ago(e.ts)}${e.p_after != null ? ` · power then ${fmtW(e.p_after)}` : ''}</div></div>
        <span class="faint num" style="font-size:12.5px">${fmtTime(e.ts)}</span></div>`).join('');
  }

  function drawChart() {
    if (!series) return;
    const to = Date.now(), from = to - RANGES[range];
    const rows = series.rows;
    const lastTs = rows.length ? rows.at(-1).ts + series.bucketMs : 0;
    const tail = series.bucketMs === 60e3 ? livePts.filter(p => p.ts >= lastTs) : [];
    const points = [...rows.map(r => ({ ts: r.ts + series.bucketMs / 2, p: r.p, max: r.p_max })), ...tail.map(p => ({ ts: p.ts, p: p.p }))];
    const lanes = KEYS.map(k => {
      const segs = segmentsFrom(rows, k, series.bucketMs);
      // extend with live points
      for (const p of tail) if (p.app[k]) { const last = segs.at(-1); if (last && p.ts - last[1] < 10e3) last[1] = p.ts + 1000; else segs.push([p.ts, p.ts + 1000]); }
      return { key: k, segs };
    });
    const opts = { from, to, points, lanes, stepMs: series.bucketMs, showMax: series.bucketMs > 60e3 };
    if (chart) chart.redraw(opts); else chart = powerChart($('#chart', root), opts);
  }

  // ---------------------------------------------------------------- interactions + live
  $('#range', root).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    range = b.dataset.r; localStorage.setItem('range', range);
    $('#range', root).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    loadSeries();
  });

  let lastDraw = 0;
  subs.push(on('data', d => {
    if (d.device !== id) return;
    live = { p: d.msg.p, confirmed: d.confirmed, model: d.msg.app, deciding: !!d.deciding, status: 'online' };
    if (sum) { sum.status = 'online'; paint(); }
    livePts.push({ ts: d.ts, p: d.msg.p, app: d.confirmed });
    if (livePts.length > 4000) livePts.splice(0, 1000);
    if (Date.now() - lastDraw > 3000 && range !== '7d') { lastDraw = Date.now(); drawChart(); }
  }));
  subs.push(on('status', d => { if (d.device === id && live) { live.status = d.status; if (d.status !== 'online') live.p = 0; paint(); } }));
  subs.push(on('event', d => {
    if (d.device !== id) return;
    events.unshift({ ts: d.ts, appliance: d.appliance, state: d.state, p_after: d.p });
    paintEvents();
    loadSummary();
  }));

  await Promise.all([loadSummary(), loadSeries(), loadEvents()]);
  const t1 = setInterval(loadSummary, 30_000);
  const t2 = setInterval(() => { if (range !== '1h') loadSeries(); }, 120_000);
  const t3 = setInterval(() => sum && paint(), 20_000);
  return () => { subs.forEach(u => u()); clearInterval(t1); clearInterval(t2); clearInterval(t3); chart?.destroy(); };
}
