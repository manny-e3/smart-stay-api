import mqtt from 'mqtt';
import { env } from '../../config/env.js';
import { db } from '../../config/db.js';
import { acceptTelemetry, normalizeHubId } from '../../services/esp32.service.js';
import { canonicalRelay, onCommand, RELAYS } from './esp32.queue.js';

/**
 * MQTT bridge for ESP32 room hubs running the MQTT firmware. Such a hub knows only its own device
 * code (SMART_XXXXXXXXXXXX), not its room: staff link the code to a room in the dashboard
 * (POST /integrations/esp32/rooms/:room/assign-hub), which stores it as the room devices'
 * capabilities.hubDeviceId.
 *
 *   <prefix>/<code>/telemetry  hub -> API   readings every 5 s, applied like HTTP telemetry
 *   <prefix>/<code>/command    API -> hub   {"command":"LIGHT_ON"} for every relay command
 *
 * Hubs on the HTTP firmware keep polling the command queue; both kinds work side by side.
 */

let client = null;
let unsubscribe = null;
const unlinkedWarnedAt = new Map(); // device code -> last "not linked to a room" warning (ms)

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isOn = (v) => v === true || String(v).toUpperCase() === 'ON';

/** Turns an MQTT firmware telemetry message into the body the HTTP telemetry endpoint takes. */
export function toTelemetryBody(deviceId, msg) {
  // With no BME680 the firmware sends made-up temperature/humidity and no pressure.
  const bmeOnline = num(msg.pressure) !== null;
  // A missing PZEM is sent as 0 V (the firmware turns NaN into 0); mains never reads 0 V.
  const voltage = num(msg.voltage_v);
  const pzemOnline = voltage !== null && voltage > 0;
  // The firmware labels pzem.energy() "energy_wh", but the PZEM library returns kWh.
  const energyKwh = num(msg.energy_wh);

  const body = {
    deviceId,
    bme680: bmeOnline
      ? { online: true, temperature: num(msg.temp), humidity: num(msg.humidity), pressure: num(msg.pressure), gasResistance: null, airQuality: null }
      : { online: false, temperature: null, humidity: null, pressure: null, gasResistance: null, airQuality: null },
    pzem: pzemOnline
      ? { online: true, voltage, current: num(msg.current_a), power: num(msg.power_w), energy: energyKwh === null ? null : energyKwh * 1000, frequency: null, pf: null }
      : { online: false, voltage: null, current: null, power: null, energy: null, frequency: null, pf: null },
    mq2: { smokeValue: num(msg.smoke_val ?? msg.aqi), smokeAlert: msg.alarm === 'SMOKE_DETECTED' },
    motion: Boolean(msg.motion),
  };

  const battery = num(msg.battery_v);
  if (battery !== null) body.battery = { voltage: battery, lowBattery: battery < 3.3 };

  const relays = {};
  for (const relay of RELAYS) {
    if (msg[relay] !== undefined) relays[relay] = isOn(msg[relay]);
  }
  if (Object.keys(relays).length) body.relays = relays;

  return body;
}

/** The firmware's command for a relay switch, e.g. ('light', true) -> 'LIGHT_ON'. Null for unknown relays. */
export function toFirmwareCommand(deviceKey, state) {
  const relay = canonicalRelay(deviceKey);
  if (!RELAYS.includes(relay)) return null;
  return `${relay.toUpperCase()}_${state ? 'ON' : 'OFF'}`;
}

/** Device code of the hub linked to a room in the dashboard, or null. */
export async function findHubForRoom(roomNumber) {
  const row = await db('devices as d')
    .join('rooms as r', 'r.id', 'd.room_id')
    .where('r.number', String(roomNumber))
    .whereRaw(`JSON_EXTRACT(d.capabilities, '$.hubDeviceId') IS NOT NULL`)
    .first(db.raw(`JSON_UNQUOTE(JSON_EXTRACT(d.capabilities, '$.hubDeviceId')) as hub`));
  // Links saved before IDs were normalized may hold the network name ("smartstay-<hex>");
  // the hub listens on its device code ("SMART_<HEX>").
  return row?.hub ? normalizeHubId(row.hub) : null;
}

/** Handles one incoming MQTT message. Exported for tests. */
export async function handleMessage(topic, payload) {
  const parts = topic.split('/');
  const kind = parts.pop();
  const deviceId = parts.pop();
  if (kind !== 'telemetry' || !deviceId) return;

  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    console.warn(`[mqtt] ${deviceId}: telemetry is not valid JSON, ignored`);
    return;
  }

  try {
    await acceptTelemetry(toTelemetryBody(deviceId, msg));
  } catch (err) {
    if (err.status === 404 || err.statusCode === 404) {
      const last = unlinkedWarnedAt.get(deviceId) || 0;
      if (Date.now() - last > 10 * 60_000) {
        unlinkedWarnedAt.set(deviceId, Date.now());
        console.warn(`[mqtt] Hub ${deviceId} is not linked to a room yet: enter its code in the SmartStay dashboard.`);
      }
      return;
    }
    console.error(`[mqtt] ${deviceId}: telemetry failed: ${err.message}`);
  }
}

/** Publishes a relay command to the room's hub. Exported for tests. */
export async function pushCommand(roomNumber, deviceKey, state, publish = (t, m) => client?.publish(t, m, { qos: 1 })) {
  const command = toFirmwareCommand(deviceKey, state);
  if (!command) return null;
  const hub = await findHubForRoom(roomNumber);
  if (!hub) return null; // no MQTT hub linked: an HTTP hub collects it from the queue instead
  const topic = `${env.mqtt.topicPrefix}/${hub}/command`;
  publish(topic, JSON.stringify({ command }));
  return { topic, command };
}

export function startMqttBridge() {
  if (!env.mqtt.url || client) return;
  const prefix = env.mqtt.topicPrefix;

  client = mqtt.connect(env.mqtt.url, {
    clientId: `smartstay-api-${Math.random().toString(16).slice(2, 10)}`,
    username: env.mqtt.username,
    password: env.mqtt.password,
    reconnectPeriod: 5000,
    clean: true,
  });

  client.on('connect', () => {
    console.log(`[mqtt] Connected to ${env.mqtt.url}`);
    client.subscribe(`${prefix}/+/telemetry`, { qos: 0 });
  });
  client.on('message', (topic, payload) => {
    handleMessage(topic, payload);
  });
  client.on('error', (err) => console.error(`[mqtt] ${err.message}`));

  unsubscribe = onCommand((roomNumber, deviceKey, state) => {
    pushCommand(roomNumber, deviceKey, state).catch((err) => console.error(`[mqtt] command for room ${roomNumber} failed: ${err.message}`));
  });
}

export async function stopMqttBridge() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (client) await client.endAsync();
  client = null;
}
