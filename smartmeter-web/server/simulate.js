// A virtual meter for testing the website without the hardware (npm run dev).
// It produces the same JSON as the firmware and feeds it through the normal ingest path (nothing is published to MQTT).
import { ingestData, ingestStatus, setQuiet } from './ingest.js';
import { one, run, tx } from './db.js';
import { APPLIANCES, APP_KEYS } from './config.js';

export const SIM_ID = 'sim-demo01';
const rnd = (a, b) => a + Math.random() * (b - a);

function makeMeter() {
  const m = {
    seq: 0, up: 0, e: 0, app: Object.fromEntries(APP_KEYS.map(k => [k, 0])), shown: null,
    decidingUntil: 0, strOnAt: null, nextSwitch: 0, dryerOffAt: 0,
  };
  m.shown = { ...m.app };
  return m;
}

function powerOf(m, t) {
  let p = 0.5;
  if (m.app.dryer) p += 1485 + rnd(-15, 15);
  if (m.app.b200) p += 227 + rnd(-3, 3);
  if (m.app.b100) p += 129 + rnd(-2, 2);
  if (m.app.straightener) {
    const s = (t - m.strOnAt) / 1000; // heats up: surge, then falls towards ~105 W
    p += s < 5 ? 450 : 105 + 110 * Math.exp(-s / 60) + rnd(-3, 3);
  }
  return Math.max(0, p + rnd(-1, 1));
}

/** One 1-second step. Switches appliances at random, like a household would. */
function step(m, t, { busy = 1 } = {}) {
  // the dryer is used in short bursts: it switches itself off after 1-4 minutes
  if (m.app.dryer && t >= m.dryerOffAt) { m.app.dryer = 0; m.decidingUntil = t + 15_000; }
  if (t >= m.nextSwitch) {
    const k = APP_KEYS[Math.floor(Math.random() * 4)];
    const hour = new Date(t + 330 * 60_000).getUTCHours();
    const active = hour >= 6 && hour <= 23 ? 1 : 0.3;
    // the dryer runs in short bursts, bulbs for longer
    if (k === 'dryer' && (m.app.dryer || Math.random() > 0.25 * active)) { m.nextSwitch = t + rnd(30, 200) * 1000 / busy; }
    else {
      m.app[k] = m.app[k] ? 0 : 1;
      if (k === 'straightener') m.strOnAt = m.app[k] ? t : null;
      if (k === 'dryer') m.dryerOffAt = t + rnd(60, 240) * 1000;
      m.decidingUntil = t + 15_000;
      m.nextSwitch = t + rnd(90, 900) * 1000 / busy;
    }
  }
  // the model shows the new state ~5 s after the switch, confirms within 15 s
  if (t >= m.decidingUntil - 10_000) m.shown = { ...m.app };
  const p = powerOf(m, t), v = 243 + rnd(-2, 2), pf = m.app.straightener && !m.app.dryer ? rnd(0.93, 0.98) : rnd(0.995, 1);
  const s = p / pf, q = Math.sqrt(Math.max(0, s * s - p * p));
  m.seq++; m.up++; m.e += p / 3600;
  return {
    id: SIM_ID, seq: m.seq, up: m.up, v: +v.toFixed(2), i: +(s / v + 0.098).toFixed(3), p: +p.toFixed(2), q: +q.toFixed(2),
    s: +s.toFixed(2), pf: +pf.toFixed(3), f: +rnd(49.95, 50.05).toFixed(2), e: +m.e.toFixed(3),
    app: { ...m.shown }, deciding: t < m.decidingUntil ? 1 : 0, rssi: Math.round(rnd(-60, -40)), heap: Math.round(rnd(9500, 12500)),
  };
}

/** Fill the last `days` of history quickly (first run only), so the charts have something to show. */
function backfill(days) {
  if (one('SELECT 1 FROM minutes WHERE device_id = ? LIMIT 1', SIM_ID)) return;
  console.log(`[sim] generating ${days} days of history for ${SIM_ID} ...`);
  const m = makeMeter();
  const t0 = Date.now() - days * 86_400_000;
  setQuiet(true);
  tx(() => {
    for (let t = t0; t < Date.now() - 120_000; t += 5000) {
      // 5 s steps (the meter's energy counter keeps exact energy); raw history only for the last 2 hours
      let msg; for (let k = 0; k < 5; k++) msg = step(m, t + k * 1000, { busy: 1 });
      ingestData(SIM_ID, msg, t);
    }
  });
  setQuiet(false);
  run('DELETE FROM raw WHERE device_id = ? AND ts < ?', SIM_ID, Date.now() - 2 * 3600_000);
  console.log('[sim] history ready');
}

export function startSimulator() {
  backfill(3);
  const m = makeMeter();
  // carry on from the stored counter so energy keeps counting smoothly
  const last = one('SELECT last_e, last_seq, last_up FROM meters WHERE device_id = ?', SIM_ID);
  if (last) { m.e = last.last_e || 0; m.seq = last.last_seq || 0; m.up = last.last_up || 0; }
  ingestStatus(SIM_ID, 'online');
  setInterval(() => ingestData(SIM_ID, step(m, Date.now(), { busy: 2 })), 1000);
  console.log(`[sim] virtual meter ${SIM_ID} running`);
}
