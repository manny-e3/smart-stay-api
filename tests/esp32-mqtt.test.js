import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, seedHotel, api } from './helpers.js';
import { db } from '../src/config/db.js';
import { telemetryIdle, popCommands } from '../src/services/esp32.service.js';
import { enqueueCommand, onCommand } from '../src/integrations/devices/esp32.queue.js';
import { toTelemetryBody, toFirmwareCommand, handleMessage, pushCommand } from '../src/integrations/devices/esp32.mqtt.js';

/**
 * Hubs on the MQTT firmware publish to smartstay/devices/<code>/telemetry and listen on
 * smartstay/devices/<code>/command. They don't know their room: staff link the code in the dashboard.
 */

const HUB = 'SMART_ABCD12345678';
let room;
beforeEach(async () => {
  await resetDb();
  room = (await seedHotel()).rooms[0];
  popCommands(room.number);
});
afterAll(() => db.destroy());

const firmwareMessage = (over = {}) => ({
  temp: 24.5, humidity: 48, pressure: 1008.2,
  aqi: 300, alarm: 'NONE', smoke_val: 300, motion: true,
  voltage_v: 229.8, current_a: 0.42, power_w: 61.3, energy_wh: 1.25,
  battery_v: '3.9',
  light: 'ON', ac: 'OFF', tv: 'OFF', fridge: 'ON',
  ...over,
});

const linkHub = () => api().post(`/integrations/esp32/rooms/${room.number}/assign-hub`).send({ deviceId: HUB }).expect((r) => expect(r.status).toBeLessThan(300));

async function publishTelemetry(msg) {
  await handleMessage(`smartstay/devices/${HUB}/telemetry`, Buffer.from(JSON.stringify(msg)));
  await telemetryIdle();
}

const stateOf = async (externalId) => {
  const dev = await db('devices').where({ external_id: externalId }).first();
  return db('device_states').where({ device_id: dev.id }).first();
};

describe('MQTT firmware telemetry', () => {
  it('maps the firmware fields to SmartStay telemetry', () => {
    const body = toTelemetryBody(HUB, firmwareMessage());
    expect(body).toMatchObject({
      deviceId: HUB,
      bme680: { online: true, temperature: 24.5, humidity: 48, pressure: 1008.2 },
      pzem: { online: true, voltage: 229.8, current: 0.42, power: 61.3, energy: 1250 }, // library kWh -> Wh
      mq2: { smokeValue: 300, smokeAlert: false },
      battery: { voltage: 3.9, lowBattery: false },
      relays: { light: true, ac: false, tv: false, fridge: true },
      motion: true,
    });
  });

  it('treats the made-up BME680 readings and a 0 V meter as missing sensors', () => {
    const msg = firmwareMessage({ voltage_v: 0, current_a: 0, power_w: 0, energy_wh: 0 });
    delete msg.pressure; // the firmware sends random temp/humidity and no pressure when the BME680 is missing
    const body = toTelemetryBody(HUB, msg);
    expect(body.bme680).toMatchObject({ online: false, temperature: null, humidity: null });
    expect(body.pzem).toMatchObject({ online: false, voltage: null, energy: null });
  });

  it('flags the smoke alarm', () => {
    expect(toTelemetryBody(HUB, firmwareMessage({ alarm: 'SMOKE_DETECTED', smoke_val: 1800 })).mq2).toEqual({ smokeValue: 1800, smokeAlert: true });
  });

  it('ignores telemetry from a hub not linked to a room', async () => {
    await publishTelemetry(firmwareMessage());
    expect(await db('devices').where('external_id', 'like', `%-${room.number}`)).toHaveLength(0);
  });

  it('applies telemetry from a linked hub to its room', async () => {
    await linkHub();
    await publishTelemetry(firmwareMessage());

    expect((await stateOf(`light-${room.number}`)).state).toMatchObject({ on: true });
    expect((await stateOf(`ac-${room.number}`)).state).toMatchObject({ on: false });
    const meter = await stateOf(`meter-pzem-${room.number}`);
    expect(meter.state).toMatchObject({ voltage: 229.8, energy: 1250 });
  });
});

describe('MQTT commands', () => {
  it('translates relay switches to firmware commands', () => {
    expect(toFirmwareCommand('light', true)).toBe('LIGHT_ON');
    expect(toFirmwareCommand('light2', false)).toBe('AC_OFF');
    expect(toFirmwareCommand('fridge', true)).toBe('FRIDGE_ON');
    expect(toFirmwareCommand('heater', true)).toBeNull();
  });

  it('publishes to the command topic of the hub linked to the room', async () => {
    await linkHub();
    const sent = [];
    const res = await pushCommand(room.number, 'tv', true, (topic, message) => sent.push({ topic, message }));
    expect(res).toEqual({ topic: `smartstay/devices/${HUB}/command`, command: 'TV_ON' });
    expect(sent).toEqual([{ topic: `smartstay/devices/${HUB}/command`, message: '{"command":"TV_ON"}' }]);
  });

  it('publishes nothing for a room with no linked hub', async () => {
    const sent = [];
    expect(await pushCommand(room.number, 'tv', true, (t, m) => sent.push(m))).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('every queued relay command reaches the command listeners', () => {
    const heard = [];
    const off = onCommand((r, key, state) => heard.push([r, key, state]));
    enqueueCommand(room.number, 'ac', true);
    off();
    enqueueCommand(room.number, 'ac', false);
    expect(heard).toEqual([[String(room.number), 'ac', true]]);
  });
});
