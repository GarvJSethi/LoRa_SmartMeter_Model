// Subscribes 24/7 to btp/meter/+/data and btp/meter/+/status on the meter's broker.
// If one way in fails (e.g. port 1883 blocked), the next URL in the list is tried.
import mqtt from 'mqtt';
import { config } from './config.js';
import { ingestData, ingestStatus } from './ingest.js';

export const mqttInfo = { broker: null, connected: false, since: null, messages: 0, errors: 0 };

export function startMqtt() {
  let idx = 0, current = null, failTimer = null;

  const connect = () => {
    const url = config.brokers[idx % config.brokers.length];
    mqttInfo.broker = url; mqttInfo.connected = false;
    console.log(`[mqtt] connecting to ${url}`);
    const c = mqtt.connect(url, {
      clientId: `smartmeter-web-${Math.random().toString(16).slice(2, 10)}`,
      clean: true, keepalive: 30, connectTimeout: 10_000, reconnectPeriod: 5_000,
    });
    current = c;
    const mine = () => current === c;   // events from an abandoned connection must not change the status

    // if this way in does not answer within 20 s, try the next one
    failTimer = setTimeout(() => { if (mine() && !mqttInfo.connected) next('timeout'); }, 20_000);

    c.on('connect', () => {
      if (!mine()) return;
      clearTimeout(failTimer);
      mqttInfo.connected = true; mqttInfo.since = Date.now();
      console.log(`[mqtt] connected to ${url}`);
      c.subscribe([`${config.topicPrefix}/+/data`, `${config.topicPrefix}/+/status`], { qos: 0 }, err => {
        if (err) console.error('[mqtt] subscribe failed', err.message);
      });
    });
    c.on('message', (topic, payload) => {
      if (!mine()) return;
      const parts = topic.split('/');
      const kind = parts.at(-1), deviceId = parts.at(-2);
      const text = payload.toString('utf8');
      try {
        if (kind === 'data') { ingestData(deviceId, JSON.parse(text)); mqttInfo.messages++; }
        else if (kind === 'status') ingestStatus(deviceId, text);
      } catch (e) { mqttInfo.errors++; if (mqttInfo.errors % 50 === 1) console.warn('[mqtt] bad message', topic, e.message); }
    });
    c.on('close', () => { if (mine()) mqttInfo.connected = false; });
    c.on('error', e => { if (!mine()) return; mqttInfo.errors++; console.warn('[mqtt] error', e.message); });
    // never connected, or lost for over a minute: move on to the next way in
    c.on('offline', () => { if (mine() && (!mqttInfo.since || Date.now() - mqttInfo.since > 60_000)) next('offline'); });
  };

  const next = why => {
    console.warn(`[mqtt] ${mqttInfo.broker} unavailable (${why}), trying the next one`);
    clearTimeout(failTimer);
    const old = current;
    current = null;
    try { old?.end(true); } catch {}
    idx++; setTimeout(connect, 1000);
  };

  connect();
}
