// Time-of-day tariff: base rate, peak windows (+%) and off-peak windows (-%), in local time (IST).
import { config, DEFAULT_TARIFF } from './config.js';

const DAY = 86_400_000;
const OFF = () => config.tzOffsetMin * 60_000;

export function normalizeTariff(t) {
  const d = DEFAULT_TARIFF;
  const win = w => (Array.isArray(w) ? w : [])
    .filter(x => /^\d{1,2}:\d{2}$/.test(x?.start) && /^\d{1,2}:\d{2}$/.test(x?.end))
    .map(x => ({ start: x.start.padStart(5, '0'), end: x.end.padStart(5, '0') }));
  const num = (v, def, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : def);
  return {
    base: num(t?.base, d.base, 0, 1000),
    peakPct: num(t?.peakPct, d.peakPct, 0, 500),
    offPeakPct: num(t?.offPeakPct, d.offPeakPct, 0, 100),
    peak: t?.peak ? win(t.peak) : d.peak,
    offPeak: t?.offPeak ? win(t.offPeak) : d.offPeak,
  };
}

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return (h % 24) * 60 + m; };
function inWindow(minOfDay, w) {
  const s = toMin(w.start), e = toMin(w.end);
  return s <= e ? minOfDay >= s && minOfDay < e : minOfDay >= s || minOfDay < e;   // wraps midnight
}
export const localMinuteOfDay = ts => Math.floor((((ts + OFF()) % DAY) + DAY) % DAY / 60_000);

/** Rate (Rs/kWh) and band at a moment. Peak wins if windows overlap. */
export function rateAt(ts, tariff) {
  const t = tariff || DEFAULT_TARIFF;
  const m = localMinuteOfDay(ts);
  if (t.peak.some(w => inWindow(m, w))) return { rate: t.base * (1 + t.peakPct / 100), band: 'peak' };
  if (t.offPeak.some(w => inWindow(m, w))) return { rate: t.base * (1 - t.offPeakPct / 100), band: 'offpeak' };
  return { rate: t.base, band: 'normal' };
}

/** Next time the band changes (for "peak ends in ..." hints). */
export function nextBandChange(ts, tariff) {
  const now = rateAt(ts, tariff).band;
  for (let k = 1; k <= 1440; k++) {
    const t = ts + k * 60_000;
    if (rateAt(t, tariff).band !== now) return { ts: Math.floor(t / 60_000) * 60_000, band: rateAt(t, tariff).band };
  }
  return null;
}

/** Cost of minute rows ({ts, energy_wh}) in Rs. */
export const costOf = (rows, tariff) => rows.reduce((s, r) => s + (r.energy_wh / 1000) * rateAt(r.ts + 30_000, tariff).rate, 0);

/** Estimated cost of running `watts` from t0 to t1 (minute steps, time-of-day aware). */
export function runCost(watts, t0, t1, tariff) {
  let cost = 0;
  for (let t = t0; t < t1; t += 60_000) {
    const dt = Math.min(60_000, t1 - t);
    cost += (watts / 1000) * (dt / 3_600_000) * rateAt(t + dt / 2, tariff).rate;
  }
  return cost;
}

// local calendar helpers (IST)
export const localDayStart = ts => Math.floor((ts + OFF()) / DAY) * DAY - OFF();
export function localMonthStart(ts) {
  const d = new Date(ts + OFF());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - OFF();
}
export function localMonthEnd(ts) {
  const d = new Date(ts + OFF());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - OFF();
}
