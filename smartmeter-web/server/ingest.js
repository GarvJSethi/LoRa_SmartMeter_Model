// Turns each MQTT message into stored data: raw log, minute averages, energy, ON/OFF events and alerts.
import { config, APPLIANCES, APP_KEYS } from './config.js';
import { one, run, all } from './db.js';
import { broadcast } from './hub.js';
import { rateAt, normalizeTariff } from './tariff.js';

const MIN = 60_000;
const state = new Map(); // deviceId -> in-memory state

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(+v) ? +v : null));
const appState = app => Object.fromEntries(APP_KEYS.map(k => [k, app && Number(app[k]) === 1 ? 1 : 0]));
const expectedPower = app => 0.5 + APPLIANCES.reduce((s, a) => s + (app[a.key] ? a.typicalW : 0), 0);

function ensureMeter(deviceId, ts) {
  let m = one('SELECT * FROM meters WHERE device_id = ?', deviceId);
  if (!m) {
    run('INSERT INTO meters (device_id, name, first_seen, last_seen, status, status_at) VALUES (?, ?, ?, ?, ?, ?)',
      deviceId, deviceId, ts, ts, 'online', ts);
    m = one('SELECT * FROM meters WHERE device_id = ?', deviceId);
  }
  return m;
}

function getState(deviceId, ts) {
  let s = state.get(deviceId);
  if (s) return s;
  const m = ensureMeter(deviceId, ts);
  s = {
    lastE: m.last_e, lastSeq: m.last_seq, lastUp: m.last_up, lastTs: m.last_seen,
    confirmed: m.confirmed_app ? JSON.parse(m.confirmed_app) : null,
    pendingSince: {}, lastP: null, acc: null,
    alerted: {}, highSince: null, online: true,
  };
  state.set(deviceId, s);
  return s;
}

function meterTariff(deviceId) {
  const r = one('SELECT u.tariff FROM meters m LEFT JOIN users u ON u.id = m.user_id WHERE m.device_id = ?', deviceId);
  return normalizeTariff(r?.tariff ? JSON.parse(r.tariff) : null);
}

// ---------------------------------------------------------------- alerts
let quiet = false; // set while the simulator fills in history, so old events do not raise alerts
export const setQuiet = v => { quiet = v; };
export function addAlert(deviceId, ts, kind, level, title, body, adminOnly = false) {
  if (quiet) return;
  const r = run('INSERT INTO alerts (device_id, ts, kind, level, title, body, admin_only) VALUES (?, ?, ?, ?, ?, ?, ?)',
    deviceId, ts, kind, level, title, body, adminOnly ? 1 : 0);
  broadcast('alert', deviceId, { id: Number(r.lastInsertRowid), ts, kind, level, title, body }, { adminOnly });
}
function once(s, key, ts, everyMs) {
  if (s.alerted[key] && ts - s.alerted[key] < everyMs) return false;
  s.alerted[key] = ts; return true;
}

function checkAlerts(deviceId, s, msg, ts, newlyOn) {
  const tariff = meterTariff(deviceId);
  const { rate, band } = rateAt(ts, tariff);
  for (const k of newlyOn) {
    const a = APPLIANCES.find(x => x.key === k);
    if (a.heavy && band === 'peak') {
      const off = tariff.base * (1 - tariff.offPeakPct / 100);
      const perH = (a.typicalW / 1000) * rate, perHOff = (a.typicalW / 1000) * off;
      addAlert(deviceId, ts, 'peak_heavy', 'info', `${a.label} running in peak hours`,
        `It costs about Rs ${perH.toFixed(2)} per hour now, against Rs ${perHOff.toFixed(2)} in off-peak hours.`);
    }
  }
  const onCount = APP_KEYS.filter(k => s.confirmed[k]).length;
  if (onCount >= 3 && newlyOn.length && once(s, 'multi', ts, 10 * MIN)) {
    addAlert(deviceId, ts, 'multi', 'info', `${onCount} appliances on together`,
      `Total power is about ${Math.round(msg.p)} W. Spreading their use out lowers the peak load.`);
  }
  if (s.confirmed.straightener && s.onSince?.straightener && ts - s.onSince.straightener > config.straightenerLeftOnMin * MIN
      && once(s, 'left_on', s.onSince.straightener, 24 * 3600 * 1000)) {
    addAlert(deviceId, ts, 'left_on', 'warn', 'Hair straightener left on?',
      `It has been on for ${Math.round((ts - s.onSince.straightener) / MIN)} minutes.`);
  }
  if (msg.p > config.highPowerW) {
    s.highSince ??= ts;
    if (ts - s.highSince > 10_000 && once(s, 'high', ts, 10 * MIN)) {
      addAlert(deviceId, ts, 'high_power', 'warn', 'High power draw', `Power has been above ${config.highPowerW} W (now ${Math.round(msg.p)} W).`);
    }
  } else s.highSince = null;
  if (msg.heap != null && msg.heap < config.heapWarn && once(s, 'heap', ts, 3600 * 1000)) {
    addAlert(deviceId, ts, 'low_heap', 'warn', 'Low free memory on the meter', `Free heap is ${msg.heap} bytes (warning below ${config.heapWarn}).`, true);
  }
}

// ---------------------------------------------------------------- minute aggregation
function newAcc(ts) {
  return { ts, n: 0, v: 0, i: 0, p: 0, q: 0, s: 0, pf: 0, f: 0, pMin: Infinity, pMax: -Infinity, e: 0,
    app: Object.fromEntries(APP_KEYS.map(k => [k, 0])), deciding: 0, exp: 0, rssi: 0, rssiN: 0, heapMin: null };
}
function flushAcc(deviceId, a) {
  if (!a || !a.n) return;
  const n = a.n, avg = x => x / n;
  const row = {
    n, v: avg(a.v), i: avg(a.i), p: avg(a.p), p_min: a.pMin, p_max: a.pMax, q: avg(a.q), s: avg(a.s), pf: avg(a.pf), f: avg(a.f),
    energy_wh: a.e, ...Object.fromEntries(APP_KEYS.map(k => [k, a.app[k] / n])), deciding: a.deciding,
    expected_p: avg(a.exp), rssi: a.rssiN ? a.rssi / a.rssiN : null, heap_min: a.heapMin,
  };
  // merge with an existing row for the same minute (e.g. after a server restart)
  const old = one('SELECT * FROM minutes WHERE device_id = ? AND ts = ?', deviceId, a.ts);
  if (old) {
    const N = old.n + n, w = (k) => (old[k] * old.n + row[k] * n) / N;
    for (const k of ['v', 'i', 'p', 'q', 's', 'pf', 'f', 'expected_p', ...APP_KEYS]) row[k] = w(k);
    row.p_min = Math.min(old.p_min, row.p_min); row.p_max = Math.max(old.p_max, row.p_max);
    row.energy_wh += old.energy_wh; row.deciding += old.deciding; row.n = N;
    row.heap_min = Math.min(old.heap_min ?? Infinity, row.heap_min ?? Infinity);
    if (!Number.isFinite(row.heap_min)) row.heap_min = null;
  }
  run(`INSERT OR REPLACE INTO minutes (device_id, ts, n, v, i, p, p_min, p_max, q, s, pf, f, energy_wh, dryer, straightener, b200, b100,
       deciding, expected_p, rssi, heap_min) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    deviceId, a.ts, row.n, row.v, row.i, row.p, row.p_min, row.p_max, row.q, row.s, row.pf, row.f, row.energy_wh,
    row.dryer, row.straightener, row.b200, row.b100, row.deciding, row.expected_p, row.rssi, row.heap_min);
}

// ---------------------------------------------------------------- energy
/** Energy (Wh) since the previous message, using the meter's own counter `e`, which resets to 0 on reboot. */
function energyDelta(s, msg, ts) {
  const e = msg.e;
  if (e == null) { // no counter: integrate power over the gap (max 10 s)
    const dt = s.lastTs ? Math.min(10, (ts - s.lastTs) / 1000) : 1;
    return { wh: Math.max(0, msg.p) * dt / 3600, reboot: false };
  }
  if (s.lastE == null) return { wh: 0, reboot: false }; // first message ever: baseline only
  const reboot = (msg.seq != null && s.lastSeq != null && msg.seq < s.lastSeq)
    || (msg.up != null && s.lastUp != null && msg.up < s.lastUp)
    || e < s.lastE - 0.001;
  let wh = reboot ? e : e - s.lastE;
  // sanity check: never more than a 3.5 kW load could use in the elapsed time
  const gapS = s.lastTs ? Math.max(1, (ts - s.lastTs) / 1000) : 1;
  const maxWh = 3500 * (reboot ? Math.max(gapS, msg.up || gapS) : gapS) / 3600 + 0.5;
  if (wh < 0 || wh > maxWh) wh = Math.max(0, msg.p) * Math.min(gapS, 10) / 3600;
  return { wh, reboot };
}

// ---------------------------------------------------------------- main entry points
export function ingestData(deviceId, raw, ts = Date.now()) {
  if (!/^[\w.-]{1,64}$/.test(deviceId)) return;
  const msg = {
    v: num(raw.v), i: num(raw.i), p: num(raw.p), q: num(raw.q), s: num(raw.s), pf: num(raw.pf), f: num(raw.f),
    e: num(raw.e), seq: num(raw.seq), up: num(raw.up), rssi: num(raw.rssi), heap: num(raw.heap),
    deciding: Number(raw.deciding) === 1 ? 1 : 0, app: appState(raw.app),
  };
  if (msg.p == null) return;
  const s = getState(deviceId, ts);

  run('INSERT INTO raw (device_id, ts, msg) VALUES (?, ?, ?)', deviceId, ts, JSON.stringify(raw));

  // energy and reboot detection
  const { wh, reboot } = energyDelta(s, msg, ts);
  if (reboot) {
    run('UPDATE meters SET reboots = reboots + 1 WHERE device_id = ?', deviceId);
    addAlert(deviceId, ts, 'reboot', 'info', 'Meter restarted', 'The energy counter started again from 0; totals continue correctly.', true);
  }

  // confirmed appliance state and ON/OFF events.
  // A change counts once the model has confirmed it (deciding = 0); it is dated when it first appeared.
  if (!s.confirmed) { s.confirmed = { ...msg.app }; s.onSince = Object.fromEntries(APP_KEYS.map(k => [k, msg.app[k] ? ts : null])); }
  s.onSince ??= Object.fromEntries(APP_KEYS.map(k => [k, s.confirmed[k] ? ts : null]));
  const newlyOn = [];
  for (const k of APP_KEYS) {
    if (msg.app[k] !== s.confirmed[k]) s.pendingSince[k] ??= { ts, pBefore: s.lastP };
    else delete s.pendingSince[k];
  }
  if (!msg.deciding) {
    for (const k of Object.keys(s.pendingSince)) {
      const pend = s.pendingSince[k];
      s.confirmed[k] = msg.app[k];
      run('INSERT INTO events (device_id, ts, appliance, state, p_before, p_after) VALUES (?, ?, ?, ?, ?, ?)',
        deviceId, pend.ts, k, msg.app[k], pend.pBefore, msg.p);
      broadcast('event', deviceId, { ts: pend.ts, appliance: k, state: msg.app[k], p: msg.p });
      if (msg.app[k]) { newlyOn.push(k); s.onSince[k] = pend.ts; } else s.onSince[k] = null;
      delete s.pendingSince[k];
    }
  }

  // minute averages (server time)
  const minute = Math.floor(ts / MIN) * MIN;
  if (s.acc && s.acc.ts !== minute) { flushAcc(deviceId, s.acc); s.acc = null; }
  const a = (s.acc ??= newAcc(minute));
  a.n++; a.v += msg.v ?? 0; a.i += msg.i ?? 0; a.p += msg.p; a.q += msg.q ?? 0; a.s += msg.s ?? 0; a.pf += msg.pf ?? 0; a.f += msg.f ?? 0;
  a.pMin = Math.min(a.pMin, msg.p); a.pMax = Math.max(a.pMax, msg.p); a.e += wh;
  for (const k of APP_KEYS) a.app[k] += s.confirmed[k];
  a.deciding += msg.deciding; a.exp += expectedPower(s.confirmed);
  if (msg.rssi != null) { a.rssi += msg.rssi; a.rssiN++; }
  if (msg.heap != null) a.heapMin = a.heapMin == null ? msg.heap : Math.min(a.heapMin, msg.heap);

  s.lastE = msg.e ?? s.lastE; s.lastSeq = msg.seq; s.lastUp = msg.up; s.lastTs = ts; s.lastP = msg.p;
  const wasOffline = !s.online; s.online = true;
  run(`UPDATE meters SET last_seen = ?, last_msg = ?, last_rssi = ?, last_heap = ?, last_e = ?, last_seq = ?, last_up = ?,
       confirmed_app = ?, status = CASE WHEN status = 'offline' THEN 'online' ELSE status END WHERE device_id = ?`,
    ts, JSON.stringify(raw), msg.rssi, msg.heap, s.lastE, msg.seq, msg.up, JSON.stringify(s.confirmed), deviceId);
  if (wasOffline) broadcast('status', deviceId, { status: 'online', ts });

  checkAlerts(deviceId, s, msg, ts, newlyOn);

  broadcast('data', deviceId, { ts, msg: raw, confirmed: s.confirmed, deciding: msg.deciding, wh });
  broadcast('raw', deviceId, { ts, msg: raw }, { adminOnly: true });
}

export function ingestStatus(deviceId, status, ts = Date.now()) {
  if (!/^[\w.-]{1,64}$/.test(deviceId)) return;
  status = String(status).trim().toLowerCase().replace(/"/g, '');
  if (!['online', 'offline'].includes(status)) return;
  const m = ensureMeter(deviceId, ts);
  const s = getState(deviceId, ts);
  if (m.status === status && m.status_at) return;
  run('UPDATE meters SET status = ?, status_at = ? WHERE device_id = ?', status, ts, deviceId);
  run('INSERT INTO status_log (device_id, ts, status) VALUES (?, ?, ?)', deviceId, ts, status);
  s.online = status === 'online';
  if (status === 'offline' && once(s, 'offline', ts, 5 * MIN)) {
    addAlert(deviceId, ts, 'offline', 'warn', 'Meter went offline', 'No data is arriving from the meter. Readings resume when it reconnects.');
  }
  broadcast('status', deviceId, { status, ts });
}

/** Every few seconds: close finished minutes and notice meters that stopped sending. */
export function housekeeping(now = Date.now()) {
  for (const [deviceId, s] of state) {
    if (s.acc && s.acc.ts + MIN <= now - 2000) { flushAcc(deviceId, s.acc); s.acc = null; }
    if (s.online && s.lastTs && now - s.lastTs > config.offlineAfterSec * 1000) {
      s.online = false;
      broadcast('status', deviceId, { status: 'offline', ts: now, reason: 'no data' });
      if (once(s, 'offline', now, 5 * MIN)) {
        addAlert(deviceId, now, 'offline', 'warn', 'Meter stopped sending data',
          `No reading for ${config.offlineAfterSec} s. It may be offline or the Wi-Fi link dropped.`);
      }
    }
  }
}
export function pruneRaw(now = Date.now()) {
  run('DELETE FROM raw WHERE ts < ?', now - config.rawRetentionHours * 3600 * 1000);
  run('DELETE FROM sessions WHERE expires_at < ?', now);
}
export const liveState = deviceId => state.get(deviceId);
export const flushAll = () => { for (const [d, s] of state) if (s.acc) { flushAcc(d, s.acc); s.acc = null; } };
export const knownDevices = () => all('SELECT device_id FROM meters').map(r => r.device_id);
