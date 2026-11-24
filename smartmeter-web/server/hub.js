// Live updates to browsers with Server-Sent Events.
// Users receive their own meters only; admins receive every meter and the raw messages.
import { all } from './db.js';

const clients = new Set();

export function addClient(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const c = { res, user, devices: allowedDevices(user) };
  clients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
}

function allowedDevices(user) {
  if (user.role === 'admin') return null; // all
  return new Set(all('SELECT device_id FROM meters WHERE user_id = ?', user.id).map(r => r.device_id));
}

/** Re-read meter assignments (after an admin changes them). */
export function refreshClients() {
  for (const c of clients) c.devices = allowedDevices(c.user);
}

export function broadcast(type, deviceId, data, { adminOnly = false } = {}) {
  const line = `event: ${type}\ndata: ${JSON.stringify({ device: deviceId, ...data })}\n\n`;
  for (const c of clients) {
    if (adminOnly && c.user.role !== 'admin') continue;
    if (c.devices && !c.devices.has(deviceId)) continue;
    c.res.write(line);
  }
}

export const clientCount = () => clients.size;
