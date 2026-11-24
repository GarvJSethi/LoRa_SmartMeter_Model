// Entry point: web server + MQTT subscriber + housekeeping.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { one, run } from './db.js';
import { hashPassword } from './auth.js';
import { handleApi } from './api.js';
import { housekeeping, pruneRaw, flushAll } from './ingest.js';
import { startMqtt } from './mqtt.js';
import { supabaseEnabled } from './supabase.js';

const PUBLIC = path.join(config.root, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

// ---------------------------------------------------------------- first start: accounts
function seed() {
  if (supabaseEnabled()) {
    // accounts live in Supabase; only make sure the project's meters exist (admins assign them)
    run('INSERT OR IGNORE INTO meters (device_id, name) VALUES (?, ?)', 'pm33-746d672b', 'Home meter');
    if (config.simulate) run('INSERT OR IGNORE INTO meters (device_id, name) VALUES (?, ?)', 'sim-demo01', 'Demo meter (simulated)');
    console.log('[setup] sign-in through Supabase');
    return;
  }
  if (one('SELECT 1 FROM users LIMIT 1')) return;
  const gen = () => crypto.randomBytes(9).toString('base64url');
  const creds = {
    note: 'Initial accounts created on first start. Change these passwords after signing in.',
    admin: { email: 'admin@meter.local', password: gen() },
    user: { email: 'user@meter.local', password: gen() },
  };
  run('INSERT INTO users (email, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', creds.admin.email, 'Admin', hashPassword(creds.admin.password), 'admin', Date.now());
  const u = run('INSERT INTO users (email, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', creds.user.email, 'Home user', hashPassword(creds.user.password), 'user', Date.now());
  const uid = Number(u.lastInsertRowid);
  // the project's meter is assigned to the first user
  run('INSERT OR IGNORE INTO meters (device_id, name, user_id) VALUES (?, ?, ?)', 'pm33-746d672b', 'Home meter', uid);
  if (config.simulate) run('INSERT OR IGNORE INTO meters (device_id, name, user_id) VALUES (?, ?, ?)', 'sim-demo01', 'Demo meter (simulated)', uid);
  fs.writeFileSync(config.seedPath, JSON.stringify(creds, null, 2));
  console.log(`[setup] first start: initial accounts written to ${config.seedPath}`);
}

// ---------------------------------------------------------------- static files
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html';        // single-page app
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- start
seed();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});
server.listen(config.port, () => console.log(`[web] http://localhost:${config.port}`));

if (config.mqttEnabled) startMqtt();
if (config.simulate) (await import('./simulate.js')).startSimulator();

setInterval(() => housekeeping(), 5_000);
setInterval(() => pruneRaw(), 30 * 60_000);
pruneRaw();

const stop = () => { flushAll(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
