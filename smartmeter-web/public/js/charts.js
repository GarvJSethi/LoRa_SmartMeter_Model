// Hand-drawn SVG charts: power over time with appliance lanes, daily bars, and a day timeline.
import { esc, fmtTime, fmtTimeS, fmtW, fmtDate, appColor, appInfo, localHour } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const niceMax = v => { if (v <= 0) return 10; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
const fmtAxisW = w => (w >= 1000 ? `${+(w / 1000).toFixed(1)}k` : `${Math.round(w)}`);

function timeTicks(from, to, width) {
  const span = to - from, target = Math.max(3, Math.floor(width / 90));
  const steps = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3];
  const step = steps.find(s => span / s <= target) || 86400e3;
  const off = 330 * 60e3; // ticks on round local times
  const out = [];
  for (let t = Math.ceil((from + off) / step) * step - off; t <= to; t += step) out.push(t);
  return { ticks: out, step };
}

/** ON segments [[t0, t1], ...] for one appliance from rows with a 0..1 share (or 0/1 state). */
export function segmentsFrom(rows, key, stepMs, getter = r => r[key]) {
  const segs = [];
  let cur = null;
  for (const r of rows) {
    const on = (getter(r) ?? 0) >= 0.5;
    if (on) { if (cur && r.ts - cur[1] <= stepMs * 1.5) cur[1] = r.ts + stepMs; else { cur = [r.ts, r.ts + stepMs]; segs.push(cur); } }
    else cur = null;
  }
  return segs;
}

/**
 * Power over time with an appliance lane under it.
 * opts: { from, to, points:[{ts,p,max?}], lanes:[{key, segs}], second?:[{ts,p}] (dashed line, e.g. expected power),
 *         marks?:[{t0,t1,label}] (labelled ranges), brush?:(t0,t1)=>void, height, laneHeight, showMax }
 */
export function powerChart(el, opts) {
  const draw = () => {
    const W = Math.max(280, el.clientWidth);
    const small = W < 520;
    const H = opts.height ?? (small ? 170 : 220);
    const lanes = opts.lanes || [];
    const laneH = opts.laneHeight ?? 13, laneGap = 6;
    const L = small ? 40 : 46, R = 8, T = 8, B = 24;
    const lanesTop = T + H + B + 6;
    const totalH = lanesTop + (lanes.length ? lanes.length * (laneH + laneGap) + 4 : 0);
    const pw = W - L - R;
    const { from, to } = opts;
    const x = t => L + ((t - from) / (to - from)) * pw;
    const pts = (opts.points || []).filter(p => p.ts >= from - 120_000 && p.ts <= to + 1000);
    const maxP = niceMax(Math.max(10, ...pts.map(p => (opts.showMax ? p.max ?? p.p : p.p)), ...(opts.second || []).map(p => p.p)) * 1.08);
    const y = v => T + H - (Math.max(0, v) / maxP) * H;
    const gid = `g${Math.random().toString(36).slice(2, 8)}`;

    let s = `<svg viewBox="0 0 ${W} ${totalH}" height="${totalH}" role="img" aria-label="Power over time">
      <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--chart-line)" stop-opacity=".28"/><stop offset="1" stop-color="var(--chart-line)" stop-opacity="0"/></linearGradient>
      <clipPath id="${gid}c"><rect x="${L}" y="0" width="${pw}" height="${totalH}"/></clipPath></defs>`;
    // grid + y labels
    for (let k = 0; k <= 4; k++) {
      const v = (maxP / 4) * k, yy = y(v);
      s += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" ${k ? 'stroke-dasharray="2 4"' : ''}/>`;
      s += `<text class="axis-text" x="${L - 8}" y="${yy + 4}" text-anchor="end">${fmtAxisW(v)}</text>`;
    }
    const { ticks, step } = timeTicks(from, to, pw);
    for (const t of ticks) s += `<text class="axis-text" x="${x(t)}" y="${T + H + 17}" text-anchor="middle">${step >= 86400e3 ? fmtDate(t) : fmtTime(t)}</text>`;
    s += `<g clip-path="url(#${gid}c)">`;
    // labelled ranges (labelling tool)
    for (const m of opts.marks || []) {
      s += `<rect x="${x(m.t0)}" y="${T}" width="${Math.max(1, x(m.t1) - x(m.t0))}" height="${H}" fill="rgba(127,178,255,.08)" stroke="rgba(127,178,255,.35)" stroke-dasharray="3 3"/>`;
      if (m.label) s += `<text class="axis-text" x="${x(m.t0) + 4}" y="${T + 12}" fill="#9cc2ff">${esc(m.label)}</text>`;
    }
    // area + line (a gap of more than 3 samples breaks the line)
    if (pts.length) {
      const gap = Math.max(...[opts.stepMs || 60_000, 2000]) * 3;
      let line = '', area = '', segStart = null, prev = null;
      const close = () => { if (segStart != null) area += `L${x(prev.ts)},${y(0)}L${x(segStart)},${y(0)}Z`; };
      for (const p of pts) {
        if (!prev || p.ts - prev.ts > gap) { close(); line += `M${x(p.ts)},${y(p.p)}`; area += `M${x(p.ts)},${y(p.p)}`; segStart = p.ts; }
        else { line += `L${x(p.ts)},${y(p.p)}`; area += `L${x(p.ts)},${y(p.p)}`; }
        prev = p;
      }
      close();
      if (opts.showMax) {
        let mx = ''; prev = null;
        for (const p of pts) { if (p.max == null) continue; mx += `${!prev || p.ts - prev.ts > gap ? 'M' : 'L'}${x(p.ts)},${y(p.max)}`; prev = p; }
        s += `<path d="${mx}" fill="none" stroke="var(--chart-line)" stroke-opacity=".28" stroke-width="1"/>`;
      }
      s += `<path d="${area}" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="var(--chart-line)" stroke-width="1.8" stroke-linejoin="round"/>`;
    }
    if (opts.second?.length) {
      let d = '', prev = null;
      for (const p of opts.second) { d += `${!prev || p.ts - prev.ts > 3 * 60_000 ? 'M' : 'L'}${x(p.ts)},${y(p.p)}`; prev = p; }
      s += `<path d="${d}" fill="none" stroke="var(--chart-2)" stroke-width="1.3" stroke-dasharray="4 3" opacity=".75"/>`;
    }
    // lanes
    lanes.forEach((ln, i) => {
      const ly = lanesTop + i * (laneH + laneGap);
      s += `<rect x="${L}" y="${ly}" width="${pw}" height="${laneH}" rx="3" fill="var(--lane-bg)"/>`;
      for (const [a, b] of ln.segs) {
        const xa = Math.max(L, x(a)), xb = Math.min(W - R, x(b));
        if (xb > xa) s += `<rect x="${xa}" y="${ly}" width="${Math.max(1.5, xb - xa)}" height="${laneH}" rx="3" fill="${appColor(ln.key)}" fill-opacity=".85"/>`;
      }
    });
    s += `</g>`;
    lanes.forEach((ln, i) => {
      const ly = lanesTop + i * (laneH + laneGap);
      s += `<text class="lane-text" x="${L - 8}" y="${ly + laneH - 2.5}" text-anchor="end" style="font-size:10.5px">${esc(laneShort(ln.key, small))}</text>`;
    });
    s += `<line class="cursor" x1="0" x2="0" y1="${T}" y2="${totalH - 2}" stroke="var(--text)" stroke-opacity=".35" visibility="hidden"/>`;
    s += `<rect class="brush" x="0" y="${T}" width="0" height="${H}" fill="var(--accent-soft)" stroke="var(--accent)" visibility="hidden"/>`;
    s += `</svg><div class="chart-tip hidden"></div>`;
    el.innerHTML = s;
    if (!pts.length && !opts.noEmptyNote) el.insertAdjacentHTML('beforeend', `<div class="empty" style="position:absolute;inset:0;display:grid;place-items:center;padding-bottom:${lanes.length * 19}px">No readings in this period</div>`);

    // hover + brush
    const svg = el.querySelector('svg'), tip = el.querySelector('.chart-tip'), cursor = svg.querySelector('.cursor'), brush = svg.querySelector('.brush');
    const toT = ev => { const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width); return { px, t: from + ((px - L) / pw) * (to - from) }; };
    let dragFrom = null;
    const move = ev => {
      const { px, t } = toT(ev);
      if (px < L || px > W - R || !pts.length) { tip.classList.add('hidden'); cursor.setAttribute('visibility', 'hidden'); return; }
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p;
      const on = lanes.filter(ln => ln.segs.some(([a, b]) => best.ts >= a && best.ts < b)).map(ln => appInfo(ln.key).short);
      cursor.setAttribute('x1', x(best.ts)); cursor.setAttribute('x2', x(best.ts)); cursor.setAttribute('visibility', 'visible');
      const exp = opts.second?.find(p => Math.abs(p.ts - best.ts) < 61_000);
      tip.innerHTML = `<div class="faint">${(opts.stepMs || 60_000) < 60_000 ? fmtTimeS(best.ts) : fmtDate(best.ts) + ', ' + fmtTime(best.ts)}</div><b class="num">${fmtW(best.p)}</b>${exp ? ` <span class="faint">· expected ${fmtW(exp.p)}</span>` : ''}${lanes.length ? `<div class="muted">${on.length ? esc(on.join(', ')) : 'No appliance on'}</div>` : ''}`;
      const r = svg.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(70, (x(best.ts) / W) * r.width), r.width - 70)}px`;
      tip.style.top = `${(y(best.p) / totalH) * r.height}px`;
      tip.classList.remove('hidden');
      if (dragFrom != null) {
        const a = Math.min(dragFrom, t), b = Math.max(dragFrom, t);
        brush.setAttribute('x', x(a)); brush.setAttribute('width', Math.max(1, x(b) - x(a))); brush.setAttribute('visibility', 'visible');
      }
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', () => { tip.classList.add('hidden'); cursor.setAttribute('visibility', 'hidden'); });
    if (opts.brush) {
      svg.style.cursor = 'crosshair';
      svg.addEventListener('pointerdown', ev => { dragFrom = Math.max(from, Math.min(to, toT(ev).t)); svg.setPointerCapture(ev.pointerId); });
      svg.addEventListener('pointerup', ev => {
        if (dragFrom == null) return;
        const t = Math.max(from, Math.min(to, toT(ev).t));
        const a = Math.min(dragFrom, t), b = Math.max(dragFrom, t);
        dragFrom = null;
        if (b - a > 1500) opts.brush(Math.round(a), Math.round(b)); else brush.setAttribute('visibility', 'hidden');
      });
      if (opts.selection) {
        const [a, b] = opts.selection;
        brush.setAttribute('x', x(a)); brush.setAttribute('width', Math.max(1, x(b) - x(a))); brush.setAttribute('visibility', 'visible');
      }
    }
  };
  draw();
  const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - (el._w || 0)) > 4) { el._w = el.clientWidth; draw(); } });
  ro.observe(el);
  return { redraw: o => { Object.assign(opts, o); draw(); }, destroy: () => ro.disconnect() };
}
const laneShort = (k, small) => ({ dryer: 'Dryer', straightener: small ? 'Straight.' : 'Straightener', b200: '200 W', b100: '100 W' }[k] || k);

/** Vertical bars, e.g. kWh per day. bars: [{label, value, title, accent}] */
export function barChart(el, { bars, height = 190, fmt = v => v.toFixed(1), unit = '' }) {
  const draw = () => {
    const W = Math.max(280, el.clientWidth), L = 36, R = 6, T = 10, B = 22, H = height;
    const max = niceMax(Math.max(0.01, ...bars.map(b => b.value)) * 1.1);
    const bw = (W - L - R) / bars.length;
    let s = `<svg viewBox="0 0 ${W} ${H + T + B}" height="${H + T + B}">`;
    for (let k = 0; k <= 4; k++) {
      const v = (max / 4) * k, yy = T + H - (v / max) * H;
      s += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" ${k ? 'stroke-dasharray="2 4"' : ''}/><text class="axis-text" x="${L - 6}" y="${yy + 4}" text-anchor="end">${+v.toFixed(v < 10 ? 1 : 0)}</text>`;
    }
    const every = Math.ceil(bars.length / Math.floor((W - L) / 34));
    bars.forEach((b, i) => {
      const h = (b.value / max) * H, xx = L + i * bw + bw * 0.18, w = bw * 0.64;
      s += `<rect x="${xx}" y="${T + H - h}" width="${Math.max(1, w)}" height="${Math.max(b.value > 0 ? 1.5 : 0, h)}" rx="${Math.min(4, w / 3)}" fill="${b.accent ? 'var(--chart-line)' : 'var(--bar)'}" ${b.accent ? '' : 'fill-opacity=".9"'}><title>${esc(b.title || `${b.label}: ${fmt(b.value)} ${unit}`)}</title></rect>`;
      if (i % every === 0) s += `<text class="axis-text" x="${xx + w / 2}" y="${T + H + 16}" text-anchor="middle">${esc(b.label)}</text>`;
    });
    el.innerHTML = s + '</svg>';
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(el);
  return { destroy: () => ro.disconnect() };
}

/** One day as lanes (00:00 to 24:00) with ON periods. lanes: [{key, runs:[{s,e,label}]}] */
export function dayTimeline(el, { from, to, lanes, now }) {
  const draw = () => {
    const W = Math.max(300, el.clientWidth), small = W < 520, L = small ? 70 : 104, R = 8, T = 22, laneH = 26, gap = 10;
    const H = T + lanes.length * (laneH + gap);
    const x = t => L + ((t - from) / (to - from)) * (W - L - R);
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}">`;
    const stepH = small ? 6 : 3;
    for (let h = 0; h <= 24; h += stepH) {
      const xx = x(from + h * 3600e3);
      s += `<line class="grid-line" x1="${xx}" x2="${xx}" y1="${T - 6}" y2="${H - gap + 2}" stroke-dasharray="2 4"/><text class="axis-text" x="${xx}" y="${T - 10}" text-anchor="middle">${String(h % 24).padStart(2, '0')}:00</text>`;
    }
    if (now && now > from && now < to) s += `<line x1="${x(now)}" x2="${x(now)}" y1="${T - 6}" y2="${H - gap + 2}" stroke="var(--chart-line)" stroke-width="1.2"/>`;
    lanes.forEach((ln, i) => {
      const yy = T + i * (laneH + gap);
      s += `<text class="lane-text" x="${L - 12}" y="${yy + laneH / 2 + 4}" text-anchor="end">${esc(small ? laneShort(ln.key, true) : appInfo(ln.key).label)}</text>`;
      s += `<rect x="${L}" y="${yy}" width="${W - L - R}" height="${laneH}" rx="6" fill="var(--lane-bg)"/>`;
      for (const r of ln.runs) {
        const a = x(Math.max(from, r.s)), b = x(Math.min(to, r.e));
        s += `<rect x="${a}" y="${yy + 3}" width="${Math.max(2, b - a)}" height="${laneH - 6}" rx="4" fill="${appColor(ln.key)}" fill-opacity="${r.open ? .55 : .85}"><title>${esc(r.label)}</title></rect>`;
      }
    });
    el.innerHTML = s + '</svg>';
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(el);
  return { destroy: () => ro.disconnect() };
}

/** Small 24-hour strip showing tariff bands. hours: [{t, band, rate}] (48 half-hours) */
export function tariffStrip(el, hours) {
  const colors = { peak: '#ff7a2f', offpeak: '#3ecf8e', normal: 'var(--tariff-normal)' };
  el.innerHTML = `<div style="display:flex;height:18px;border-radius:6px;overflow:hidden;gap:1px">${hours.map(h =>
    `<span style="flex:1;background:${colors[h.band]};opacity:${h.band === 'normal' ? 1 : .85}" title="${fmtTime(h.t)} · ₹${h.rate.toFixed(2)}/kWh"></span>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;margin-top:6px" class="faint num">${[0, 6, 12, 18, 24].map(hh => `<span style="font-size:11px">${String(hh % 24).padStart(2, '0')}:00</span>`).join('')}</div>`;
}
export { localHour };
