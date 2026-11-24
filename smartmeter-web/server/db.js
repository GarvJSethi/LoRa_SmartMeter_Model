// SQLite storage (Node's built-in node:sqlite). One file, created on first start.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  tariff TEXT,                       -- JSON, NULL = default tariff
  alert_prefs TEXT,                  -- JSON
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meters (
  device_id TEXT PRIMARY KEY,
  name TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_seen INTEGER,
  last_seen INTEGER,
  status TEXT DEFAULT 'unknown',     -- online / offline as published on the status topic
  status_at INTEGER,
  last_msg TEXT,                     -- last data message (JSON)
  last_rssi INTEGER,
  last_heap INTEGER,
  last_e REAL,                       -- for energy deltas across reboots
  last_seq INTEGER,
  last_up INTEGER,
  confirmed_app TEXT,                -- confirmed appliance state (JSON)
  reboots INTEGER DEFAULT 0
);
-- one row per meter per minute (server time)
CREATE TABLE IF NOT EXISTS minutes (
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,               -- minute start, ms
  n INTEGER NOT NULL,
  v REAL, i REAL, p REAL, p_min REAL, p_max REAL, q REAL, s REAL, pf REAL, f REAL,
  energy_wh REAL NOT NULL DEFAULT 0,
  dryer REAL, straightener REAL, b200 REAL, b100 REAL,   -- share of samples with the appliance ON
  deciding INTEGER DEFAULT 0,        -- samples with deciding = 1
  expected_p REAL,                   -- power expected from the detected appliances
  rssi REAL, heap_min INTEGER,
  PRIMARY KEY (device_id, ts)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  appliance TEXT NOT NULL,
  state INTEGER NOT NULL,            -- 1 = switched ON, 0 = switched OFF
  p_before REAL, p_after REAL,
  source TEXT DEFAULT 'model'        -- model / reboot / offline
);
CREATE INDEX IF NOT EXISTS events_dev_ts ON events(device_id, ts);
CREATE TABLE IF NOT EXISTS raw (
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_dev_ts ON raw(device_id, ts);
CREATE TABLE IF NOT EXISTS status_log (
  device_id TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',   -- info / warn / critical
  title TEXT NOT NULL,
  body TEXT,
  admin_only INTEGER DEFAULT 0,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_dev_ts ON alerts(device_id, ts);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  dryer INTEGER NOT NULL, straightener INTEGER NOT NULL, b200 INTEGER NOT NULL, b100 INTEGER NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
`);

// migrations for databases created by an earlier version
const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!cols.includes('supabase_id')) db.exec('ALTER TABLE users ADD COLUMN supabase_id TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_id ON users(supabase_id)');

// small helpers
export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
