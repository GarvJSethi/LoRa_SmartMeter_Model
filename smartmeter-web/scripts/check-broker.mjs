// Listens on the public brokers for the meter's messages (read-only) and reports what it sees.
// Usage: node scripts/check-broker.mjs [seconds]
import mqtt from 'mqtt';

const SECONDS = Number(process.argv[2] || 25);
const BROKERS = [
  'mqtt://broker.emqx.io:1883', 'wss://broker.emqx.io:8084/mqtt',
  'mqtt://broker.hivemq.com:1883', 'wss://broker.hivemq.com:8884/mqtt',
  'mqtt://test.mosquitto.org:1883', 'wss://test.mosquitto.org:8081/mqtt',
];

const results = await Promise.all(BROKERS.map(url => new Promise(resolve => {
  const r = { url, connected: false, error: null, status: {}, data: {}, lastData: null };
  const c = mqtt.connect(url, { connectTimeout: 10_000, reconnectPeriod: 0, clientId: `check-${Math.random().toString(16).slice(2, 8)}` });
  c.on('connect', () => { r.connected = true; c.subscribe(['btp/meter/+/data', 'btp/meter/+/status']); });
  c.on('message', (topic, payload) => {
    const [, , id, kind] = topic.split('/');
    if (kind === 'status') r.status[id] = payload.toString();
    else { r.data[id] = (r.data[id] || 0) + 1; r.lastData = payload.toString().slice(0, 160); }
  });
  c.on('error', e => { r.error = e.message; });
  setTimeout(() => { c.end(true); resolve(r); }, SECONDS * 1000);
})));

for (const r of results) {
  console.log(`${r.url.padEnd(40)} ${r.connected ? 'connected' : `NOT connected${r.error ? ` (${r.error})` : ''}`}`);
  if (Object.keys(r.status).length) console.log(`   status (retained): ${JSON.stringify(r.status)}`);
  if (Object.keys(r.data).length) console.log(`   data messages in ${SECONDS}s: ${JSON.stringify(r.data)}\n   last: ${r.lastData}`);
}
process.exit(0);
