// HTTP API. Every route returns JSON (or CSV for exports).
import { config, APPLIANCES, APP_KEYS, DEFAULT_TARIFF } from './config.js';
import { one, all, run } from './db.js';
import * as auth from './auth.js';
import { normalizeTariff, rateAt, nextBandChange, costOf, runCost, localDayStart, localMonthStart, localMonthEnd } from './tariff.js';
import { liveState } from './ingest.js';
import { addClient, refreshClients } from './hub.js';
import { mqttInfo } from './mqtt.js';
import * as sbase from './supabase.js';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// ---------------------------------------------------------------- tiny router
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, ...opts });
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

export async function handleApi(req, res, url) {
  const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
  if (!r) return send(res, 404, { error: 'Not found' });
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
  try {
    const user = auth.userFromRequest(req);
    if (!r.public && !user) fail(401, 'Please sign in');
    if (r.admin && user.role !== 'admin') fail(403, 'Admins only');
    const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readJson(req) : {};
    const q = Object.fromEntries(url.searchParams);
    const out = await r.handler({ req, res, user, params, q, body });
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
}
function send(res, status, obj, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1_000_000) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
function sendCsv(res, filename, header, rows) {
  const esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const text = [header.join(','), ...rows.map(r => r.map(esc).join(','))].join('\n') + '\n';
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.end(text);
}

// ---------------------------------------------------------------- helpers
const userTariff = u => normalizeTariff(u?.tariff ? JSON.parse(u.tariff) : null);
function meterTariff(deviceId) {
  const r = one('SELECT u.tariff FROM meters m LEFT JOIN users u ON u.id = m.user_id WHERE m.device_id = ?', deviceId);
  return normalizeTariff(r?.tariff ? JSON.parse(r.tariff) : null);
}
function access(user, deviceId) {
  const m = one('SELECT * FROM meters WHERE device_id = ?', deviceId);
  if (!m) fail(404, 'Meter not found');
  if (user.role !== 'admin' && m.user_id !== user.id) fail(403, 'Not your meter');
  return m;
}
export function meterStatus(m, now = Date.now()) {
  if (!m.last_seen) return 'never';
  if (m.status === 'offline') return 'offline';
  return now - m.last_seen <= config.offlineAfterSec * 1000 ? 'online' : 'offline';
}
const range = (q, defMs) => {
  const to = Number(q.to) || Date.now();
  const from = Number(q.from) || to - defMs;
  if (to <= from) fail(400, 'Bad range');
  return { from, to };
};
const parseJson = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const round = (x, n = 3) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);

/** Energy rows in a range, including the minute still being collected in memory. */
function energyRows(deviceId, from, to) {
  const rows = all('SELECT ts, energy_wh FROM minutes WHERE device_id = ? AND ts >= ? AND ts < ?', deviceId, from, to);
  const acc = liveState(deviceId)?.acc;
  if (acc && acc.ts >= from && acc.ts < to && !rows.some(r => r.ts === acc.ts)) rows.push({ ts: acc.ts, energy_wh: acc.e });
  return rows;
}
const sumKwh = rows => rows.reduce((s, r) => s + r.energy_wh, 0) / 1000;

/** ON periods per appliance from the event log, clipped to [from, to]. */
function runsFor(deviceId, from, to, tariff) {
  const out = [];
  for (const a of APPLIANCES) {
    const before = one('SELECT state, ts FROM events WHERE device_id = ? AND appliance = ? AND ts < ? ORDER BY ts DESC LIMIT 1', deviceId, a.key, from);
    const evs = all('SELECT ts, state FROM events WHERE device_id = ? AND appliance = ? AND ts >= ? AND ts < ? ORDER BY ts', deviceId, a.key, from, to);
    let start = before?.state === 1 ? before.ts : null;
    const push = (s, e, open) => {
      const cs = Math.max(s, from), ce = Math.min(e, to);
      if (ce <= cs) return;
      out.push({ appliance: a.key, start: s, end: open ? null : e, clippedStart: cs, clippedEnd: ce, durationMs: ce - cs,
        kwhEst: round((a.typicalW / 1000) * (ce - cs) / HOUR, 4), costEst: round(runCost(a.typicalW, cs, ce, tariff), 2) });
    };
    for (const ev of evs) {
      if (ev.state === 1 && start == null) start = ev.ts;
      else if (ev.state === 0 && start != null) { push(start, ev.ts, false); start = null; }
    }
    if (start != null) push(start, to, true);
  }
  return out.sort((x, y) => x.clippedStart - y.clippedStart);
}

// ---------------------------------------------------------------- auth
route('GET', '/api/config', () => ({
  auth: sbase.supabaseEnabled() ? 'supabase' : 'local',
  supabaseUrl: config.supabaseUrl || null, supabaseAnonKey: config.supabaseAnonKey || null,
  canManageUsers: sbase.supabaseEnabled() ? sbase.canManageUsers() : true,
}), { public: true });

/** Keep a local copy of a Supabase user (meters, tariffs and alerts hang on the local id). */
function upsertSbUser({ id, email, full_name, role }) {
  role = role === 'admin' ? 'admin' : 'user';
  const name = full_name || (email || '').split('@')[0] || 'User';
  let u = one('SELECT * FROM users WHERE supabase_id = ?', id) || (email ? one('SELECT * FROM users WHERE email = ?', email) : null);
  if (u) run('UPDATE users SET supabase_id = ?, email = ?, name = ?, role = ? WHERE id = ?', id, email || u.email, name, role, u.id);
  else {
    const r = run('INSERT INTO users (email, name, pass_hash, role, created_at, supabase_id) VALUES (?, ?, ?, ?, ?, ?)', email || `${id}@supabase`, name, '!supabase', role, Date.now(), id);
    u = { id: Number(r.lastInsertRowid) };
  }
  return one('SELECT * FROM users WHERE id = ?', u.id);
}

// Supabase sign-in: the browser signs in with Supabase and hands its access token over once.
// The server checks it with Supabase, reads the role from public.profiles and opens a normal session.
route('POST', '/api/session', async ({ req, res, body }) => {
  if (!sbase.supabaseEnabled()) fail(400, 'Supabase sign-in is not configured');
  const ip = auth.clientIp(req);
  if (auth.tooManyAttempts(ip)) fail(429, 'Too many attempts. Try again in a few minutes.');
  const token = String(body.access_token || '');
  let sbUser, profile;
  try {
    sbUser = await sbase.getAuthUser(token);
    profile = await sbase.getOwnProfile(token, sbUser.id);
  } catch (e) { auth.noteFailure(ip); fail(401, 'Your sign-in could not be verified. Please try again.'); }
  if (!profile) fail(403, 'Your account has no profile yet. Ask an administrator to set it up.');
  const u = upsertSbUser({ id: sbUser.id, email: sbUser.email, full_name: profile.full_name, role: profile.role });
  const session = auth.createSession(u.id);
  send(res, 200, { ok: true, role: u.role, name: u.name }, { 'Set-Cookie': auth.sessionCookie(session, config.sessionDays * 86400, req) });
}, { public: true });

route('POST', '/api/login', ({ req, res, body }) => {
  if (sbase.supabaseEnabled()) fail(400, 'Sign-in goes through Supabase on this site');
  const ip = auth.clientIp(req);
  if (auth.tooManyAttempts(ip)) fail(429, 'Too many attempts. Try again in a few minutes.');
  const u = one('SELECT * FROM users WHERE email = ?', String(body.email || '').trim());
  if (!u || !auth.verifyPassword(String(body.password || ''), u.pass_hash)) { auth.noteFailure(ip); fail(401, 'Email or password is incorrect'); }
  const token = auth.createSession(u.id);
  send(res, 200, { ok: true, role: u.role }, { 'Set-Cookie': auth.sessionCookie(token, config.sessionDays * 86400, req) });
}, { public: true });

route('POST', '/api/logout', ({ res, user }) => {
  auth.destroySession(user.token);
  send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', 0) });
});

route('GET', '/api/me', ({ user }) => ({
  id: user.id, email: user.email, name: user.name, role: user.role, authMode: sbase.supabaseEnabled() ? 'supabase' : 'local',
  tariff: userTariff(user), defaultTariff: DEFAULT_TARIFF,
  alertPrefs: parseJson(user.alert_prefs, { peak: true, multi: true, leftOn: true, offline: true, high: true }),
  appliances: APPLIANCES, tzOffsetMin: config.tzOffsetMin, heapWarn: config.heapWarn,
}));

route('PUT', '/api/me/password', ({ user, body }) => {
  if (sbase.supabaseEnabled()) fail(400, 'Change your password through Supabase sign-in');
  const u = one('SELECT pass_hash FROM users WHERE id = ?', user.id);
  if (!auth.verifyPassword(String(body.current || ''), u.pass_hash)) fail(400, 'Current password is incorrect');
  if (String(body.next || '').length < 8) fail(400, 'Use at least 8 characters');
  run('UPDATE users SET pass_hash = ? WHERE id = ?', auth.hashPassword(body.next), user.id);
  return { ok: true };
});

route('PUT', '/api/me/alert-prefs', ({ user, body }) => {
  const p = Object.fromEntries(['peak', 'multi', 'leftOn', 'offline', 'high'].map(k => [k, body[k] !== false]));
  run('UPDATE users SET alert_prefs = ? WHERE id = ?', JSON.stringify(p), user.id);
  return p;
});

// ---------------------------------------------------------------- live stream
route('GET', '/api/stream', ({ req, res, user }) => { addClient(req, res, user); return undefined; });

// ---------------------------------------------------------------- user: meters and dashboard
function meterCard(m) {
  const st = liveState(m.device_id);
  return {
    deviceId: m.device_id, name: m.name || m.device_id, status: meterStatus(m), lastSeen: m.last_seen,
    rssi: m.last_rssi, heap: m.last_heap, last: parseJson(m.last_msg),
    confirmed: st?.confirmed || parseJson(m.confirmed_app), userId: m.user_id,
  };
}
route('GET', '/api/meters', ({ user }) => {
  const rows = user.role === 'admin'
    ? all('SELECT * FROM meters ORDER BY (user_id IS NULL), device_id')
    : all('SELECT * FROM meters WHERE user_id = ? ORDER BY device_id', user.id);
  return rows.map(meterCard);
});

route('GET', '/api/meters/:id/summary', ({ user, params }) => {
  const m = access(user, params.id);
  const now = Date.now(), tariff = meterTariff(m.device_id);
  const r = rateAt(now, tariff), next = nextBandChange(now, tariff);
  const last = parseJson(m.last_msg), st = liveState(m.device_id);
  const status = meterStatus(m, now);
  const p = status === 'online' && last ? last.p : 0;
  const dayStart = localDayStart(now), monthStart = localMonthStart(now), monthEnd = localMonthEnd(now);
  const today = energyRows(m.device_id, dayStart, now + MIN), month = energyRows(m.device_id, monthStart, now + MIN);
  const monthKwh = sumKwh(month), monthCost = costOf(month, tariff);
  const elapsed = Math.max(HOUR, now - monthStart);
  // running since: from memory, else from the last ON event
  const onSince = {};
  const confirmed = st?.confirmed || parseJson(m.confirmed_app) || {};
  for (const k of APP_KEYS) {
    if (!confirmed[k]) { onSince[k] = null; continue; }
    onSince[k] = st?.onSince?.[k] ?? one('SELECT ts FROM events WHERE device_id = ? AND appliance = ? AND state = 1 ORDER BY ts DESC LIMIT 1', m.device_id, k)?.ts ?? null;
  }
  const runsToday = runsFor(m.device_id, dayStart, now, tariff);
  const perAppToday = Object.fromEntries(APP_KEYS.map(k => {
    const rs = runsToday.filter(x => x.appliance === k);
    return [k, { runs: rs.length, minutes: Math.round(rs.reduce((s, x) => s + x.durationMs, 0) / MIN), costEst: round(rs.reduce((s, x) => s + x.costEst, 0), 2) }];
  }));
  return {
    meter: meterCard(m), status, power: p, costPerHour: round((p / 1000) * r.rate, 2),
    rate: { ...r, next }, tariff,
    deciding: last?.deciding === 1, confirmed, model: last?.app || null, onSince, perAppToday,
    today: { kwh: round(sumKwh(today)), cost: round(costOf(today, tariff), 2) },
    month: { kwh: round(monthKwh), cost: round(monthCost, 2), projectedCost: round(monthCost * (monthEnd - monthStart) / elapsed, 0) },
  };
});

route('GET', '/api/meters/:id/series', ({ user, params, q }) => {
  const m = access(user, params.id);
  const { from, to } = range(q, 6 * HOUR);
  const span = to - from;
  const bucket = span <= 12 * HOUR ? MIN : span <= 3 * DAY ? 5 * MIN : span <= 14 * DAY ? 15 * MIN : HOUR;
  const rows = bucket === MIN
    ? all(`SELECT ts, p, p_min, p_max, v, pf, energy_wh, dryer, straightener, b200, b100, deciding, expected_p
           FROM minutes WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts`, m.device_id, from, to)
    : all(`SELECT (ts / ${bucket}) * ${bucket} AS ts, AVG(p) p, MIN(p_min) p_min, MAX(p_max) p_max, AVG(v) v, AVG(pf) pf,
           SUM(energy_wh) energy_wh, AVG(dryer) dryer, AVG(straightener) straightener, AVG(b200) b200, AVG(b100) b100,
           SUM(deciding) deciding, AVG(expected_p) expected_p
           FROM minutes WHERE device_id = ? AND ts >= ? AND ts < ? GROUP BY ts / ${bucket} ORDER BY ts`, m.device_id, from, to);
  return { from, to, bucketMs: bucket, rows: rows.map(r => ({ ...r, ts: Number(r.ts) })) };
});

route('GET', '/api/meters/:id/runs', ({ user, params, q }) => {
  const m = access(user, params.id);
  const now = Date.now();
  const from = Number(q.from) || localDayStart(now), to = Math.min(Number(q.to) || now, now);
  const tariff = meterTariff(m.device_id);
  const runs = runsFor(m.device_id, from, to, tariff);
  const energy = energyRows(m.device_id, from, to);
  const kwh = sumKwh(energy), cost = costOf(energy, tariff);
  const byApp = APPLIANCES.map(a => {
    const rs = runs.filter(x => x.appliance === a.key);
    return { appliance: a.key, runs: rs.length, minutes: round(rs.reduce((s, x) => s + x.durationMs, 0) / MIN, 1),
      kwhEst: round(rs.reduce((s, x) => s + x.kwhEst, 0), 3), costEst: round(rs.reduce((s, x) => s + x.costEst, 0), 2) };
  });
  return { from, to, runs, byApp, total: { kwh: round(kwh), cost: round(cost, 2) } };
});

route('GET', '/api/meters/:id/events', ({ user, params, q }) => {
  const m = access(user, params.id);
  const { from, to } = range(q, DAY);
  return all('SELECT ts, appliance, state, p_before, p_after FROM events WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 2000', m.device_id, from, to);
});

route('GET', '/api/meters/:id/daily', ({ user, params, q }) => {
  const m = access(user, params.id);
  const now = Date.now();
  let start = localMonthStart(now);
  if (/^\d{4}-\d{2}$/.test(q.month || '')) { const [y, mo] = q.month.split('-').map(Number); start = Date.UTC(y, mo - 1, 1) - config.tzOffsetMin * MIN; }
  const end = localMonthEnd(start + DAY);
  const tariff = meterTariff(m.device_id);
  const rows = energyRows(m.device_id, start, end);
  const days = [];
  for (let d = start; d < end; d += DAY) {
    const dr = rows.filter(r => r.ts >= d && r.ts < d + DAY);
    days.push({ day: d, kwh: round(sumKwh(dr)), cost: round(costOf(dr, tariff), 2) });
  }
  return { start, end, days };
});

// ---------------------------------------------------------------- tariff
route('GET', '/api/tariff', ({ user }) => {
  const t = userTariff(user);
  const day = localDayStart(Date.now());
  return { tariff: t, defaults: DEFAULT_TARIFF, hours: Array.from({ length: 48 }, (_, i) => ({ t: day + i * 30 * MIN, ...rateAt(day + i * 30 * MIN + 1, t) })) };
});
route('PUT', '/api/tariff', ({ user, body }) => {
  const t = normalizeTariff(body);
  run('UPDATE users SET tariff = ? WHERE id = ?', JSON.stringify(t), user.id);
  return t;
});

// ---------------------------------------------------------------- alerts
route('GET', '/api/alerts', ({ user, q }) => {
  const limit = Math.min(500, Number(q.limit) || 100);
  if (user.role === 'admin') return all('SELECT * FROM alerts ORDER BY ts DESC LIMIT ?', limit);
  const prefs = parseJson(user.alert_prefs, {});
  const off = { peak_heavy: prefs.peak === false, multi: prefs.multi === false, left_on: prefs.leftOn === false, offline: prefs.offline === false, high_power: prefs.high === false };
  return all(`SELECT a.* FROM alerts a JOIN meters m ON m.device_id = a.device_id
              WHERE m.user_id = ? AND a.admin_only = 0 ORDER BY a.ts DESC LIMIT ?`, user.id, limit * 2)
    .filter(a => !off[a.kind]).slice(0, limit);
});
route('POST', '/api/alerts/read', ({ user, body }) => {
  const now = Date.now();
  if (body.all) {
    if (user.role === 'admin') run('UPDATE alerts SET read_at = ? WHERE read_at IS NULL', now);
    else run(`UPDATE alerts SET read_at = ? WHERE read_at IS NULL AND admin_only = 0 AND device_id IN (SELECT device_id FROM meters WHERE user_id = ?)`, now, user.id);
  } else for (const id of [].concat(body.ids || [])) {
    const a = one('SELECT device_id FROM alerts WHERE id = ?', Number(id));
    if (a) { access(user, a.device_id); run('UPDATE alerts SET read_at = ? WHERE id = ?', now, Number(id)); }
  }
  return { ok: true };
});

// ---------------------------------------------------------------- CSV export
route('GET', '/api/meters/:id/export.csv', ({ res, user, params, q }) => {
  const m = access(user, params.id);
  const { from, to } = range(q, DAY);
  const tariff = meterTariff(m.device_id);
  const offH = `${config.tzOffsetMin >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(config.tzOffsetMin) / 60)).padStart(2, '0')}:${String(Math.abs(config.tzOffsetMin) % 60).padStart(2, '0')}`;
  const iso = ts => new Date(ts + config.tzOffsetMin * MIN).toISOString().slice(0, 19) + offH;
  const name = `${m.device_id}_${q.kind || 'minutes'}_${iso(from).slice(0, 10)}`;
  if (q.kind === 'events') {
    const rows = all('SELECT ts, appliance, state, p_before, p_after FROM events WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts', m.device_id, from, to);
    return sendCsv(res, `${name}.csv`, ['time_ist', 'appliance', 'action', 'power_before_W', 'power_after_W'],
      rows.map(r => [iso(r.ts), r.appliance, r.state ? 'ON' : 'OFF', round(r.p_before, 1), round(r.p_after, 1)]));
  }
  if (q.kind === 'runs') {
    const rows = runsFor(m.device_id, from, Math.min(to, Date.now()), tariff);
    return sendCsv(res, `${name}.csv`, ['appliance', 'start_ist', 'end_ist', 'minutes', 'kwh_est', 'cost_rs_est'],
      rows.map(r => [r.appliance, iso(r.clippedStart), r.end ? iso(r.clippedEnd) : '', round(r.durationMs / MIN, 1), r.kwhEst, r.costEst]));
  }
  const rows = all('SELECT * FROM minutes WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts', m.device_id, from, to);
  return sendCsv(res, `${name}.csv`,
    ['time_ist', 'samples', 'voltage_V', 'current_A', 'power_W', 'power_min_W', 'power_max_W', 'pf', 'freq_Hz', 'energy_Wh', 'rate_rs_kwh', 'cost_rs', ...APPLIANCES.map(a => `${a.csv}_on_share`)],
    rows.map(r => { const rt = rateAt(r.ts + 30_000, tariff).rate; return [iso(r.ts), r.n, round(r.v, 2), round(r.i, 3), round(r.p, 1), round(r.p_min, 1), round(r.p_max, 1), round(r.pf, 3), round(r.f, 2), round(r.energy_wh, 4), round(rt, 2), round(r.energy_wh / 1000 * rt, 4), ...APP_KEYS.map(k => round(r[k], 2))]; }));
});

// ================================================================ admin
route('GET', '/api/admin/overview', () => {
  const now = Date.now();
  const meters = all(`SELECT m.*, u.name AS user_name, u.email AS user_email FROM meters m LEFT JOIN users u ON u.id = m.user_id ORDER BY m.device_id`);
  const counts = Object.fromEntries(all('SELECT device_id, COUNT(*) c FROM raw WHERE ts > ? GROUP BY device_id', now - 5 * MIN).map(r => [r.device_id, r.c]));
  return {
    mqtt: mqttInfo, heapWarn: config.heapWarn, now,
    meters: meters.map(m => ({
      deviceId: m.device_id, name: m.name, status: meterStatus(m, now), lastSeen: m.last_seen, firstSeen: m.first_seen,
      rssi: m.last_rssi, heap: m.last_heap, user: m.user_id ? { id: m.user_id, name: m.user_name, email: m.user_email } : null,
      msgsPerMin: round((counts[m.device_id] || 0) / 5, 1), reboots: m.reboots, uptime: parseJson(m.last_msg)?.up ?? null,
      power: parseJson(m.last_msg)?.p ?? null,
    })),
    users: one('SELECT COUNT(*) c FROM users').c,
    unreadAlerts: one('SELECT COUNT(*) c FROM alerts WHERE read_at IS NULL').c,
  };
}, { admin: true });

route('PUT', '/api/admin/meters/:id', ({ params, body }) => {
  const m = one('SELECT * FROM meters WHERE device_id = ?', params.id);
  if (!m) fail(404, 'Meter not found');
  const name = body.name !== undefined ? String(body.name).slice(0, 60) : m.name;
  let userId = m.user_id;
  if (body.userId !== undefined) {
    userId = body.userId === null || body.userId === '' ? null : Number(body.userId);
    if (userId && !one('SELECT 1 FROM users WHERE id = ?', userId)) fail(400, 'Unknown user');
  }
  run('UPDATE meters SET name = ?, user_id = ? WHERE device_id = ?', name, userId, params.id);
  refreshClients();
  return { ok: true };
}, { admin: true });

route('POST', '/api/admin/meters', ({ body }) => {
  const id = String(body.deviceId || '').trim();
  if (!/^[\w.-]{1,64}$/.test(id)) fail(400, 'Device ID may use letters, digits, - _ and .');
  if (one('SELECT 1 FROM meters WHERE device_id = ?', id)) fail(409, 'This meter already exists');
  run('INSERT INTO meters (device_id, name, user_id) VALUES (?, ?, ?)', id, body.name || id, body.userId || null);
  refreshClients();
  return { ok: true };
}, { admin: true });

route('GET', '/api/admin/users', async ({ req }) => {
  let synced = null;
  if (sbase.supabaseEnabled()) {
    // refresh the local copy from Supabase (the admin's own token via RLS, or the service key)
    const token = req.headers['x-sb-token'] || null;
    if (token || sbase.canManageUsers()) {
      try {
        const profiles = await sbase.listProfiles(token);
        for (const p of profiles) upsertSbUser(p);
        synced = profiles.length;
      } catch (e) { synced = `failed: ${e.message}`; }
    }
  }
  const users = all(`SELECT u.id, u.email, u.name, u.role, u.tariff, u.created_at, u.supabase_id,
       (SELECT GROUP_CONCAT(device_id) FROM meters WHERE user_id = u.id) AS meters FROM users u ORDER BY u.role DESC, u.name`)
    .map(u => ({ ...u, tariff: normalizeTariff(parseJson(u.tariff)), customTariff: !!u.tariff, meters: u.meters ? u.meters.split(',') : [] }));
  return { users, authMode: sbase.supabaseEnabled() ? 'supabase' : 'local', canManage: !sbase.supabaseEnabled() || sbase.canManageUsers(), synced };
}, { admin: true });

route('POST', '/api/admin/users', async ({ body }) => {
  const email = String(body.email || '').trim(), name = String(body.name || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Enter a valid email');
  if (!name) fail(400, 'Enter a name');
  if (sbase.supabaseEnabled()) {
    if (!sbase.canManageUsers()) fail(400, 'Add SUPABASE_SERVICE_ROLE_KEY to .env to create users here, or create them in Supabase');
    if (String(body.password || '').length < 6) fail(400, 'Password needs at least 6 characters');
    const u = await sbase.createAuthUser({ email, password: body.password, fullName: name, role: body.role === 'admin' ? 'admin' : 'user' });
    return { id: upsertSbUser({ id: u.id, email, full_name: name, role: body.role }).id };
  }
  if (String(body.password || '').length < 8) fail(400, 'Password needs at least 8 characters');
  if (one('SELECT 1 FROM users WHERE email = ?', email)) fail(409, 'A user with this email exists');
  const r = run('INSERT INTO users (email, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    email, name, auth.hashPassword(body.password), body.role === 'admin' ? 'admin' : 'user', Date.now());
  return { id: Number(r.lastInsertRowid) };
}, { admin: true });

route('PUT', '/api/admin/users/:id', async ({ user, params, body }) => {
  const u = one('SELECT * FROM users WHERE id = ?', Number(params.id));
  if (!u) fail(404, 'User not found');
  const role = body.role === 'admin' || body.role === 'user' ? body.role : u.role;
  if (u.id === user.id && role !== 'admin') fail(400, 'You cannot remove your own admin role');
  if (u.supabase_id && sbase.supabaseEnabled()) {
    // name, role and password live in Supabase
    const nameChanged = body.name && body.name !== u.name;
    if ((nameChanged || role !== u.role || body.password) && !sbase.canManageUsers()) fail(400, 'Add SUPABASE_SERVICE_ROLE_KEY to .env to change names, roles or passwords here, or change them in Supabase');
    if (nameChanged || role !== u.role) await sbase.setProfile(u.supabase_id, { full_name: body.name || u.name, role });
    if (body.password) {
      if (String(body.password).length < 6) fail(400, 'Password needs at least 6 characters');
      await sbase.setAuthPassword(u.supabase_id, body.password);
      run('DELETE FROM sessions WHERE user_id = ?', u.id);
    }
    run('UPDATE users SET name = ?, role = ? WHERE id = ?', body.name ? String(body.name).slice(0, 80) : u.name, role, u.id);
    if (body.tariff !== undefined) run('UPDATE users SET tariff = ? WHERE id = ?', body.tariff ? JSON.stringify(normalizeTariff(body.tariff)) : null, u.id);
    return { ok: true };
  }
  run('UPDATE users SET name = ?, role = ? WHERE id = ?', body.name ? String(body.name).slice(0, 80) : u.name, role, u.id);
  if (body.password) {
    if (String(body.password).length < 8) fail(400, 'Password needs at least 8 characters');
    run('UPDATE users SET pass_hash = ? WHERE id = ?', auth.hashPassword(body.password), u.id);
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
  }
  if (body.tariff !== undefined) run('UPDATE users SET tariff = ? WHERE id = ?', body.tariff ? JSON.stringify(normalizeTariff(body.tariff)) : null, u.id);
  return { ok: true };
}, { admin: true });

route('DELETE', '/api/admin/users/:id', async ({ user, params }) => {
  if (Number(params.id) === user.id) fail(400, 'You cannot delete your own account');
  const su = one('SELECT supabase_id FROM users WHERE id = ?', Number(params.id));
  if (su?.supabase_id && sbase.supabaseEnabled()) {
    if (!sbase.canManageUsers()) fail(400, 'Add SUPABASE_SERVICE_ROLE_KEY to .env to delete users here, or delete them in Supabase');
    await sbase.deleteAuthUser(su.supabase_id);
  }
  run('DELETE FROM users WHERE id = ?', Number(params.id));
  refreshClients();
  return { ok: true };
}, { admin: true });

// model monitoring
route('GET', '/api/admin/model/:id', ({ params, q }) => {
  const id = params.id;
  if (!one('SELECT 1 FROM meters WHERE device_id = ?', id)) fail(404, 'Meter not found');
  const hours = Math.min(24 * 30, Math.max(1, Number(q.hours) || 24));
  const from = Date.now() - hours * HOUR;
  const evs = all('SELECT ts, appliance, state FROM events WHERE device_id = ? AND ts >= ? ORDER BY ts', id, from);
  const perApp = APPLIANCES.map(a => ({ appliance: a.key, on: evs.filter(e => e.appliance === a.key && e.state === 1).length, off: evs.filter(e => e.appliance === a.key && e.state === 0).length }));
  // short ON periods (< 30 s) usually mean the model changed its mind
  let flicker = 0;
  for (const a of APP_KEYS) {
    const e = evs.filter(x => x.appliance === a);
    for (let k = 1; k < e.length; k++) if (e[k - 1].state === 1 && e[k].state === 0 && e[k].ts - e[k - 1].ts < 30_000) flicker++;
  }
  const mins = all('SELECT ts, n, p, expected_p, deciding FROM minutes WHERE device_id = ? AND ts >= ? ORDER BY ts', id, from);
  const samples = mins.reduce((s, r) => s + r.n, 0), deciding = mins.reduce((s, r) => s + r.deciding, 0);
  const mismatches = mins.filter(r => r.deciding === 0 && Math.abs(r.p - r.expected_p) > config.mismatchW);
  const resid = mins.filter(r => r.deciding === 0).map(r => r.p - r.expected_p);
  const mae = resid.length ? resid.reduce((s, x) => s + Math.abs(x), 0) / resid.length : null;
  return {
    hours, from, perApp, events: evs.length, flicker, samples, decidingSamples: deciding,
    decidingShare: samples ? round(deciding / samples, 4) : null,
    minutes: mins.length, mismatchMinutes: mismatches.length, mismatchW: config.mismatchW, meanAbsResidualW: round(mae, 1),
    series: mins.map(r => ({ ts: r.ts, p: round(r.p, 1), expected: round(r.expected_p, 1), deciding: r.deciding })),
    worst: mismatches.sort((a, b) => Math.abs(b.p - b.expected_p) - Math.abs(a.p - a.expected_p)).slice(0, 20)
      .map(r => ({ ts: r.ts, p: round(r.p, 1), expected: round(r.expected_p, 1), diff: round(r.p - r.expected_p, 1) })),
  };
}, { admin: true });

// raw message viewer
route('GET', '/api/admin/raw', ({ q }) => {
  const limit = Math.min(1000, Number(q.limit) || 200);
  const rows = q.device
    ? all('SELECT device_id, ts, msg FROM raw WHERE device_id = ? ORDER BY ts DESC LIMIT ?', q.device, limit)
    : all('SELECT device_id, ts, msg FROM raw ORDER BY ts DESC LIMIT ?', limit);
  return rows.map(r => ({ device: r.device_id, ts: r.ts, msg: parseJson(r.msg) }));
}, { admin: true });

// labelling tool
route('GET', '/api/admin/label/:id', ({ params, q }) => {
  const { from, to } = range(q, HOUR);
  if (to - from > 6 * HOUR) fail(400, 'Pick at most 6 hours');
  const rows = all('SELECT ts, msg FROM raw WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts', params.id, from, to);
  const oldest = one('SELECT MIN(ts) t FROM raw WHERE device_id = ?', params.id)?.t ?? null;
  return {
    from, to, oldestRaw: oldest,
    samples: rows.map(r => { const m = parseJson(r.msg, {}); return { ts: r.ts, v: m.v, i: m.i, p: m.p, pf: m.pf, app: m.app || {}, deciding: m.deciding }; }),
    labels: all('SELECT * FROM labels WHERE device_id = ? AND end_ts > ? AND start_ts < ? ORDER BY start_ts', params.id, from, to),
  };
}, { admin: true });

route('POST', '/api/admin/labels', ({ user, body }) => {
  const s = Number(body.start_ts), e = Number(body.end_ts);
  if (!one('SELECT 1 FROM meters WHERE device_id = ?', body.device_id)) fail(404, 'Meter not found');
  if (!(e > s)) fail(400, 'Select a time range');
  const b = k => (body[k] ? 1 : 0);
  const r = run(`INSERT INTO labels (device_id, start_ts, end_ts, dryer, straightener, b200, b100, note, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    body.device_id, s, e, b('dryer'), b('straightener'), b('b200'), b('b100'), String(body.note || '').slice(0, 200), user.id, Date.now());
  return { id: Number(r.lastInsertRowid) };
}, { admin: true });

route('DELETE', '/api/admin/labels/:id', ({ params }) => { run('DELETE FROM labels WHERE id = ?', Number(params.id)); return { ok: true }; }, { admin: true });

route('GET', '/api/admin/label/:id/export.csv', ({ res, params, q }) => {
  const { from, to } = range(q, HOUR);
  const raw = all('SELECT ts, msg FROM raw WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts', params.id, from, to);
  const labels = all('SELECT * FROM labels WHERE device_id = ? AND end_ts > ? AND start_ts < ?', params.id, from, to);
  const useModel = q.mode === 'model';
  const out = [];
  for (const r of raw) {
    const m = parseJson(r.msg, {});
    const lab = labels.find(l => r.ts >= l.start_ts && r.ts < l.end_ts);
    let y = null;
    if (lab) y = APP_KEYS.map(k => lab[k]);
    else if (useModel && !m.deciding) y = APP_KEYS.map(k => (Number(m.app?.[k]) === 1 ? 1 : 0));
    if (!y || m.p == null) continue;
    const row = [m.v, m.i, m.p, m.pf, ...y];
    out.push(q.ts === '1' ? [r.ts, ...row] : row);
  }
  const header = ['voltage_V', 'current_A', 'power_W', 'pf', ...APPLIANCES.map(a => a.csv)];
  return sendCsv(res, `labels_${params.id}_${from}.csv`, q.ts === '1' ? ['ts_ms', ...header] : header, out);
}, { admin: true });

route('GET', '/api/health', () => ({ ok: true, mqtt: mqttInfo.connected, broker: mqttInfo.broker }), { public: true });
