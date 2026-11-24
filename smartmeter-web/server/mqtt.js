// Subscribes 24/7 to btp/meter/+/data and btp/meter/+/status, moving to the next broker if one is unreachable.
import mqtt from 'mqtt';
import { config } from './config.js';
import { ingestData, ingestStatus } from './ingest.js';

export const mqttInfo = { broker: null, connected: false, since: null, messages: 0, errors: 0 };

export function startMqtt() {
  let idx = 0, client = null, failTimer = null;

  const connect = () => {
    const url = config.brokers[idx % config.brokers.length];
    mqttInfo.broker = url; mqttInfo.connected = false;
    console.log(`[mqtt] connecting to ${url}`);
    client = mqtt.connect(url, {
      clientId: `smartmeter-web-${Math.random().toString(16).slice(2, 10)}`,
      clean: true, keepalive: 30, connectTimeout: 10_000, reconnectPeriod: 5_000,
    });
    // if the broker does not answer within 20 s, try the next one
    failTimer = setTimeout(() => { if (!mqttInfo.connected) next('timeout'); }, 20_000);

    client.on('connect', () => {
      clearTimeout(failTimer);
      mqttInfo.connected = true; mqttInfo.since = Date.now();
      console.log(`[mqtt] connected to ${url}`);
      client.subscribe([`${config.topicPrefix}/+/data`, `${config.topicPrefix}/+/status`], { qos: 0 }, err => {
        if (err) console.error('[mqtt] subscribe failed', err.message);
      });
    });
    client.on('message', (topic, payload) => {
      const parts = topic.split('/');
      const kind = parts.at(-1), deviceId = parts.at(-2);
      const text = payload.toString('utf8');
      try {
        if (kind === 'data') { ingestData(deviceId, JSON.parse(text)); mqttInfo.messages++; }
        else if (kind === 'status') ingestStatus(deviceId, text);
      } catch (e) { mqttInfo.errors++; if (mqttInfo.errors % 50 === 1) console.warn('[mqtt] bad message', topic, e.message); }
    });
    client.on('close', () => { mqttInfo.connected = false; });
    client.on('error', e => { mqttInfo.errors++; console.warn('[mqtt] error', e.message); });
    client.on('offline', () => { if (Date.now() - (mqttInfo.since || 0) > 60_000) next('offline'); });
  };

  const next = why => {
    console.warn(`[mqtt] ${mqttInfo.broker} unavailable (${why}), trying next broker`);
    clearTimeout(failTimer);
    try { client.end(true); } catch {}
    idx++; setTimeout(connect, 1000);
  };

  connect();
}
