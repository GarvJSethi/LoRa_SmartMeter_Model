// All settings in one place. Every value can be overridden with an environment variable.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// read smartmeter-web/.env (KEY=value lines) without overriding real environment variables
try {
  // strip the byte-order mark Windows PowerShell adds to UTF-8 files
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file */ }

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

export const config = {
  root,
  port: Number(env('PORT', 8080)),
  dbPath: env('DB_PATH', path.join(root, 'data', 'smartmeter.db')),
  seedPath: env('SEED_PATH', path.join(root, 'data', 'seed.json')),

  // MQTT: tried in order, the next one is used if one cannot be reached.
  // All defaults point at the broker the meter publishes to (broker.emqx.io): plain MQTT first, then MQTT over
  // secure WebSockets on port 8084, which gets through networks that block port 1883.
  // (Switching to a different broker would not help: the meter's messages only exist on its own broker.)
  brokers: env('MQTT_BROKERS', 'mqtt://broker.emqx.io:1883,wss://broker.emqx.io:8084/mqtt').split(',').map(s => s.trim()),
  topicPrefix: env('TOPIC_PREFIX', 'btp/meter'),
  mqttEnabled: env('MQTT', '1') !== '0',

  // India Standard Time (no daylight saving): tariff windows and "today" use this offset
  tzOffsetMin: Number(env('TZ_OFFSET_MIN', 330)),

  rawRetentionHours: Number(env('RAW_RETENTION_HOURS', 72)), // raw 1 s messages kept for the labelling tool
  offlineAfterSec: Number(env('OFFLINE_AFTER_SEC', 30)),     // no data for this long -> treated as offline
  heapWarn: Number(env('HEAP_WARN', 9000)),
  highPowerW: Number(env('HIGH_POWER_W', 2200)),
  straightenerLeftOnMin: Number(env('STRAIGHTENER_LEFT_ON_MIN', 45)),
  mismatchW: Number(env('MISMATCH_W', 90)),                  // |measured - expected| above this = mismatch

  simulate: process.argv.includes('--simulate') || env('SIMULATE', '0') === '1',
  sessionDays: 14,

  // Supabase Auth. When URL + anon key are set, sign-in goes through Supabase and roles come from public.profiles.
  // The anon (publishable) key is safe in the browser. The service_role key is optional and stays on the server:
  // it lets admins create users, change roles and reset passwords from the console.
  supabaseUrl: env('SUPABASE_URL', '').replace(/\/+$/, ''),
  supabaseAnonKey: env('SUPABASE_ANON_KEY', ''),
  supabaseServiceKey: env('SUPABASE_SERVICE_ROLE_KEY', ''),
};

// Appliances as they appear in the payload's "app" object, with display data.
// typicalW = measured (uncalibrated) steady power, used for cost estimates and the mismatch check.
export const APPLIANCES = [
  { key: 'dryer', label: 'Hair dryer', short: 'Dryer', typicalW: 1485, heavy: true, csv: 'hair_dryer' },
  { key: 'straightener', label: 'Hair straightener', short: 'Straightener', typicalW: 116, heavy: true, csv: 'hair_straightener' },
  { key: 'b200', label: '200 W bulb', short: '200 W bulb', typicalW: 227, heavy: false, csv: 'bulb_200W' },
  { key: 'b100', label: '100 W bulb', short: '100 W bulb', typicalW: 129, heavy: false, csv: 'bulb_100W' },
];
export const APP_KEYS = APPLIANCES.map(a => a.key);

export const DEFAULT_TARIFF = {
  base: 8,                                    // Rs per kWh
  peakPct: 20,                                // + % during peak windows
  offPeakPct: 20,                             // - % during off-peak windows
  peak: [{ start: '14:00', end: '17:00' }, { start: '22:00', end: '01:00' }],
  offPeak: [{ start: '04:00', end: '10:00' }],
};
