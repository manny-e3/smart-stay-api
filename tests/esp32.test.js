import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, as, seedHotel, api } from './helpers.js';
import { db } from '../src/config/db.js';
import { Esp32Adapter } from '../src/integrations/devices/esp32.adapter.js';

/**
 * ESP32 room hubs can't be reached from the server, so every command is queued and the hub
 * collects it from GET /integrations/esp32/rooms/:room/commands.
 */

let hotel;
let room;
beforeEach(async () => {
  await resetDb();
  hotel = await seedHotel();
  room = hotel.rooms[0];
});
afterAll(() => db.destroy());

const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

/** The hub reports in, which creates its relay and sensor devices for the room. */
const hubTelemetry = (relays = { light: false, ac: false, tv: false, fridge: true }) =>
  api().post('/integrations/esp32/telemetry').send({ roomNumber: room.number, deviceId: 'SMART_TEST01', relays, mq2: { smokeValue: 100, smokeAlert: false } }).expect(200);

const hubPoll = async () => (await api().get(`/integrations/esp32/rooms/${room.number}/commands`).expect(200)).body.data.commands;

const hubDevice = (externalId) => db('devices as d').join('adapters as a', 'a.id', 'd.adapter_id').where({ 'a.vendor': 'esp32', 'd.external_id': externalId }).first('d.*');

async function signedInGuest() {
  const fd = await as('front_desk');
  const stay = (await fd.post('/admin/stays').send({ guest: { firstName: 'Ada', lastName: 'Obi' }, roomId: room.id, arrival: inHours(-1), departure: inHours(24) })).body.data.stay;
  const { accessCode } = (await fd.post(`/admin/stays/${stay.id}/check-in`)).body.data;
  const token = (await api().post('/guest/login').send({ bookingCode: accessCode })).body.data.token;
  return (path, body) => api().post(path).set('Authorization', `Bearer ${token}`).send(body);
}

describe('ESP32 room hub commands', () => {
  it('queues guest app commands for the hub instead of calling it, and hands each over once', async () => {
    await hubTelemetry();
    const guest = await signedInGuest();
    const light = await hubDevice(`light-${room.number}`);

    const res = await guest(`/guest/devices/${light.id}/command`, { on: true });
    expect(res.status).toBe(200);
    expect(res.body.data.device.state).toMatchObject({ on: true });

    expect(await hubPoll()).toEqual([expect.objectContaining({ device: 'light', state: true })]);
    expect(await hubPoll()).toEqual([]);
  });

  it('maps the AC and old channel names to the right relay; setpoint-only changes switch nothing', async () => {
    await hubTelemetry({ light: false, ac: true, tv: false, fridge: true });
    const guest = await signedInGuest();
    const ac = await hubDevice(`ac-${room.number}`);

    expect((await guest(`/guest/devices/${ac.id}/command`, { power: false })).status).toBe(200);
    expect(await hubPoll()).toEqual([expect.objectContaining({ device: 'ac', state: false })]);

    expect((await guest(`/guest/devices/${ac.id}/command`, { setpoint: 23 })).status).toBe(200);
    expect(await hubPoll()).toEqual([]);

    const adapter = new Esp32Adapter({ id: ac.adapter_id, vendor: 'esp32', config: {} });
    const bedside = await hubDevice(`light-2-${room.number}`); // channel 2 is the AC relay on the board
    expect(await adapter.sendCommand(bedside, { on: true })).toMatchObject({ ok: true });
    expect(await hubPoll()).toEqual([expect.objectContaining({ device: 'ac', state: true })]);
  });

  it('a hub reporting the old relay state right after a command does not flip it back', async () => {
    await hubTelemetry();
    const guest = await signedInGuest();
    const light = await hubDevice(`light-${room.number}`);
    await guest(`/guest/devices/${light.id}/command`, { on: true }).expect(200);

    await hubTelemetry({ light: false, ac: false, tv: false, fridge: true }); // built before the hub switched
    const state = await db('device_states').where({ device_id: light.id }).first();
    expect(state.state).toMatchObject({ on: true });
  });

  it('refuses devices that are not relays on the hub', async () => {
    await hubTelemetry();
    const sensor = await hubDevice(`sensor-mq2-${room.number}`);
    const adapter = new Esp32Adapter({ id: sensor.adapter_id, vendor: 'esp32', config: {} });
    expect(await adapter.sendCommand(sensor, { on: true })).toMatchObject({ ok: false });
    expect(await hubPoll()).toEqual([]);
  });
});
