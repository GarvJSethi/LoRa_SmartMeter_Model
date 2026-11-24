// Passwords (scrypt) and cookie sessions. No external packages.
import crypto from 'node:crypto';
import { one, run } from './db.js';
import { config } from './config.js';

export const COOKIE = 'sm_session';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [kind, s, h] = String(stored).split('$');
  if (kind !== 'scrypt' || !s || !h) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(h, 'base64');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, Date.now() + config.sessionDays * 86_400_000);
  return token;
}
export const destroySession = token => run('DELETE FROM sessions WHERE token = ?', token);

export function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const u = one(`SELECT u.id, u.email, u.name, u.role, u.tariff, u.alert_prefs, s.expires_at
                 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
  if (!u) return null;
  if (u.expires_at < Date.now()) { destroySession(token); return null; }
  return { ...u, token };
}

export function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
// behind a hosting proxy (Render), the original scheme and client IP arrive in X-Forwarded-* headers
export const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!req.socket.encrypted;
export const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
export const sessionCookie = (token, maxAgeSec, req) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${req && isHttps(req) ? '; Secure' : ''}`;

// simple login throttle: 8 failed attempts per IP per 10 minutes
const fails = new Map();
export function tooManyAttempts(ip) {
  const now = Date.now();
  const f = (fails.get(ip) || []).filter(t => now - t < 600_000);
  fails.set(ip, f);
  return f.length >= 8;
}
export const noteFailure = ip => fails.set(ip, [...(fails.get(ip) || []), Date.now()]);
