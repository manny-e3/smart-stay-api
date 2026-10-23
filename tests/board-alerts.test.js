import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, as, seedHotel, checkIn, api } from './helpers.js';
import { db } from '../src/config/db.js';
import { outbox } from '../src/core/notifier.js';
import { ingestEvent } from '../src/modules/devices/devices.service.js';
import { reportGuestIssue } from '../src/modules/alerts/alerts.service.js';
import { checkAdapterHealth } from '../src/jobs/adapterHealth.job.js';
import { runDevicePoll } from '../src/jobs/devicePoll.job.js';
import { MockAdapter } from '../src/adapters/mock.js';

let hotel;
beforeEach(async () => {
  await resetDb();
  hotel = await seedHotel();
});
afterAll(() => db.destroy());

const device = (roomId, type) => db('devices').where({ room_id: roomId, type }).first();

describe('room board', () => {
  it('computes status by priority and groups by floor', async () => {
    const [r101, r102, r103, r201] = hotel.rooms;
    await checkIn(r101.id);
    await checkIn(r102.id);
    await db('rooms').where({ id: r102.id }).update({ dnd: true });
    await checkIn(r103.id);
    const service = await as('service');
    await service.post('/admin/requests').send({ roomId: r103.id, category: 'food' });
    await ingestEvent(await device(r201.id, 'lock'), { type: 'fault', payload: { message: 'Jammed' } });

    const board = (await (await as('front_desk')).get('/admin/rooms/board')).body.data;
    const status = Object.fromEntries(board.floors.flatMap((f) => f.rooms).map((r) => [r.number, r.status]));
    expect(status).toMatchObject({ 101: 'occupied', 102: 'dnd', 103: 'request', 201: 'alert', 202: 'vacant' });
    expect(board.counts).toMatchObject({ alert: 1, request: 1, dnd: 1, occupied: 1, vacant: 2, total: 6 });
    expect(board.floors.map((f) => f.number)).toEqual([1, 2]);
    expect(board.floors[0].rooms[0].number).toBe('103'); // request before dnd before occupied
    const r201Summary = board.floors[1].rooms[0];
    expect(r201Summary).toMatchObject({ number: '201', alertSeverity: 'critical', openAlerts: 1 });
  });

  it('filters by floor, status and room type', async () => {
    const fd = await as('front_desk');
    expect((await fd.get('/admin/rooms/board?floor=2')).body.data.floors.map((f) => f.number)).toEqual([2]);
    expect((await fd.get('/admin/rooms/board?status=occupied')).body.data.floors).toEqual([]);
    expect((await fd.get('/admin/rooms/board?roomType=Suite')).body.data.counts.total).toBe(0);
    expect((await fd.get('/admin/rooms/board?status=bogus')).status).toBe(400);
  });

  it('returns room detail with guest, requests, alerts and devices', async () => {
    const room = hotel.rooms[0];
    await checkIn(room.id, 'Bola');
    await (await as('service')).post('/admin/requests').send({ roomId: room.id, category: 'laundry' });
    await ingestEvent(await device(room.id, 'thermostat'), { type: 'status', payload: { state: { mode: 'cool', setpoint: 21 } } });
    const detail = (await (await as('maintenance')).get(`/admin/rooms/${room.id}`)).body.data;
    expect(detail.stay.guest.firstName).toBe('Bola');
    expect(detail.requests).toHaveLength(1);
    expect(detail.devices.find((d) => d.type === 'thermostat').state).toMatchObject({ mode: 'cool', setpoint: 21 });
    expect((await (await as('maintenance')).get('/admin/rooms/99999')).status).toBe(404);
  });
});

describe('alerts', () => {
  it('groups duplicate device events into one alert', async () => {
    const lock = await device(hotel.rooms[0].id, 'lock');
    await ingestEvent(lock, { type: 'fault', payload: { message: 'Jammed' } });
    await ingestEvent(lock, { type: 'fault', payload: { message: 'Jammed again' } });
    await ingestEvent(lock, { type: 'fault', payload: { message: 'Still jammed' } });

    const list = (await (await as('maintenance')).get('/admin/alerts?status=open')).body.data;
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ type: 'device_fault', occurrenceCount: 3, message: 'Still jammed', severity: 'critical' });
    expect(list.openCounts.critical).toBe(1);
    // Only the first occurrence notifies
    expect(outbox.webPush.filter((p) => p.payload.data.type === 'alert')).toHaveLength(1);
  });

  it('creates an offline alert when a device goes offline', async () => {
    const t = await device(hotel.rooms[1].id, 'thermostat');
    await ingestEvent(t, { type: 'offline' });
    await ingestEvent(t, { type: 'offline' });
    const alerts = await db('alerts').where({ type: 'device_offline' });
    expect(alerts).toHaveLength(1);
  });

  it('resolves only with a note, and a new fault opens a new alert', async () => {
    const lock = await device(hotel.rooms[0].id, 'lock');
    await ingestEvent(lock, { type: 'fault' });
    const alert = await db('alerts').first();
    const m = await as('maintenance');

    expect((await m.patch(`/admin/alerts/${alert.id}`).send({ status: 'resolved' })).status).toBe(400);
    const ok = await m.patch(`/admin/alerts/${alert.id}`).send({ status: 'resolved', note: 'Replaced battery pack' });
    expect(ok.body.data).toMatchObject({ status: 'resolved', resolutionNote: 'Replaced battery pack' });
    expect((await m.patch(`/admin/alerts/${alert.id}`).send({ status: 'resolved', note: 'again' })).status).toBe(400);

    await ingestEvent(lock, { type: 'fault' });
    expect(await db('alerts').count({ n: '*' }).first()).toMatchObject({ n: 2 });
  });

  it('shows device history in the alert detail', async () => {
    const lock = await device(hotel.rooms[0].id, 'lock');
    await ingestEvent(lock, { type: 'low_battery', payload: { level: 8 } });
    const alert = await db('alerts').first();
    const detail = (await (await as('manager')).get(`/admin/alerts/${alert.id}`)).body.data;
    expect(detail.deviceHistory[0]).toMatchObject({ type: 'low_battery' });
    expect(detail.occurrences).toHaveLength(1);
    expect(detail.message).toBe('Battery at 8%');
  });

  it('lists guest-reported issues', async () => {
    await reportGuestIssue({ roomId: hotel.rooms[2].id, category: 'noise', description: 'Loud music next door' });
    const list = (await (await as('maintenance')).get('/admin/alerts?source=guest')).body.data;
    expect(list.items[0]).toMatchObject({ type: 'guest_issue', source: 'guest', message: 'Loud music next door' });
  });

  it('records unlocks in the audit log and DND on the room', async () => {
    const lock = await device(hotel.rooms[0].id, 'lock');
    const { guestId } = await checkIn(hotel.rooms[0].id);
    await ingestEvent(lock, { type: 'unlock', payload: { guestId, method: 'mobile_key' } });
    await ingestEvent(lock, { type: 'dnd_on' });
    const unlocks = (await (await as('manager')).get('/admin/audit?action=room.unlock')).body.data.items;
    expect(unlocks[0]).toMatchObject({ actor: { type: 'guest', id: guestId }, room: { number: '101' } });
    expect((await db('rooms').where({ id: hotel.rooms[0].id }).first()).dnd).toBe(true);
  });
});

describe('adapters and webhooks', () => {
  it('accepts webhook events with the right secret only', async () => {
    const admin = await as('admin');
    const { webhookSecret, webhookUrl } = (await admin.post(`/admin/rooms/mapping/adapters/${hotel.adapterId}/secret`)).body.data;

    const body = { events: [{ externalId: 'lock-101', type: 'fault', payload: { message: 'Tamper' } }, { externalId: 'nope', type: 'online' }] };
    expect((await api().post(webhookUrl).set('X-Adapter-Secret', 'wrong').send(body)).status).toBe(401);
    const ok = await api().post(webhookUrl).set('X-Adapter-Secret', webhookSecret).send(body);
    expect(ok.status).toBe(202);
    expect(ok.body.data.accepted).toBe(1);
    expect(await db('alerts').where({ type: 'device_fault' }).first()).toBeTruthy();
  });

  it('marks an adapter down after repeated failures and raises an alert', async () => {
    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({ simulateDown: true }) });
    for (let i = 0; i < 3; i++) await checkAdapterHealth(await db('adapters').where({ id: hotel.adapterId }).first());
    const adapter = (await (await as('admin')).get('/admin/rooms/mapping/adapters')).body.data[0];
    expect(adapter.health).toMatchObject({ status: 'down', consecutiveFailures: 3, lastError: 'Simulated outage' });
    expect(await db('alerts').where({ type: 'adapter_down' }).first()).toBeTruthy();
  });

  it('polling applies changed device states only', async () => {
    MockAdapter.setState(hotel.adapterId, 'thermostat-101', { online: true, state: { mode: 'heat', setpoint: 24 } });
    expect(await runDevicePoll()).toBe(1);
    expect(await runDevicePoll()).toBe(0);
    const t = await device(hotel.rooms[0].id, 'thermostat');
    expect((await db('device_states').where({ device_id: t.id }).first()).state).toMatchObject({ mode: 'heat', setpoint: 24 });
  });
});

describe('room and device mapping', () => {
  it('replaces the mapping and deactivates what is left out', async () => {
    const admin = await as('admin');
    const res = await admin.put('/admin/rooms/mapping').send({
      floors: [{ number: 1, name: 'Ground' }, { number: 5 }],
      roomTypes: ['Standard', 'Suite'],
      adapters: [{ name: 'Mock', vendor: 'mock' }],
      rooms: [
        { number: '101', floor: 1, roomType: 'Standard', devices: [{ adapter: 'Mock', externalId: 'lock-101', type: 'lock' }, { adapter: 'Mock', externalId: 'phone-1', type: 'phone' }, { adapter: 'Mock', externalId: 'phone-2', type: 'phone' }, { adapter: 'Mock', externalId: 'phone-3', type: 'phone' }] },
        { number: '501', floor: 5, roomType: 'Suite', devices: [] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ rooms: 2, roomsDeactivated: 5 });
    expect(res.body.data.warnings[0]).toMatch(/more phones/);

    const board = (await admin.get('/admin/rooms/board')).body.data;
    expect(board.floors.flatMap((f) => f.rooms).map((r) => r.number).sort()).toEqual(['101', '501']);
    expect(await db('devices').where({ is_active: true }).count({ n: '*' }).first()).toMatchObject({ n: 4 });
  });

  it('rejects devices mapped to two rooms and unknown floors', async () => {
    const admin = await as('admin');
    const dupe = await admin.put('/admin/rooms/mapping').send({
      floors: [{ number: 1 }],
      rooms: [
        { number: '101', floor: 1, devices: [{ adapter: 'Mock', externalId: 'x', type: 'lock' }] },
        { number: '102', floor: 1, devices: [{ adapter: 'Mock', externalId: 'x', type: 'lock' }] },
        { number: '103', floor: 9 },
      ],
    });
    expect(dupe.status).toBe(400);
    expect(dupe.body.details.map((d) => d.message).join(' ')).toMatch(/more than one room.*floor 9/s);
  });

  it('keeps masked adapter credentials when the mapping is saved back', async () => {
    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({ apiKey: 'real-secret', baseUrl: 'http://x' }) });
    const admin = await as('admin');
    const current = (await admin.get('/admin/rooms/mapping')).body.data;
    expect(current.adapters[0].config.apiKey).toBe('********');
    await admin.put('/admin/rooms/mapping').send({
      floors: current.floors.map((f) => ({ number: f.number })),
      roomTypes: current.roomTypes,
      adapters: current.adapters.map((a) => ({ name: a.name, vendor: a.vendor, config: a.config })),
      rooms: current.rooms.map((r) => ({ number: r.number, floor: r.floor, roomType: r.roomType, devices: r.devices.map((d) => ({ adapter: d.adapter, externalId: d.externalId, type: d.type })) })),
    });
    expect((await db('adapters').where({ id: hotel.adapterId }).first()).config.apiKey).toBe('real-secret');
  });
});

describe('room CRUD management', () => {
  it('adds a new room with floor and roomType creation', async () => {
    const admin = await as('admin');
    const res = await admin.post('/admin/rooms').send({
      number: '301',
      floor: 3,
      roomType: 'Penthouse',
      isActive: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.number).toBe('301');
    expect(res.body.data.floor).toBe(3);
    expect(res.body.data.roomType).toBe('Penthouse');

    const board = (await admin.get('/admin/rooms/board')).body.data;
    const room301 = board.floors.find((f) => f.number === 3)?.rooms.find((r) => r.number === '301');
    expect(room301).toBeDefined();
    expect(room301.roomType?.name || room301.roomType).toBe('Penthouse');
    expect(room301.status).toBe('vacant');
  });

  it('rejects duplicate room numbers on create', async () => {
    const admin = await as('admin');
    const res = await admin.post('/admin/rooms').send({ number: '101', floor: 1 });
    expect(res.status).toBe(409);
  });

  it('edits an existing room number, floor, roomType, and active status', async () => {
    const admin = await as('admin');
    const room = hotel.rooms[0];
    const res = await admin.patch(`/admin/rooms/${room.id}`).send({
      number: '101-Renovated',
      floor: 1,
      roomType: 'Deluxe Suite',
      dnd: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.number).toBe('101-Renovated');
    expect(res.body.data.roomType).toBe('Deluxe Suite');
    expect(res.body.data.dnd).toBe(true);
  });

  it('deletes an empty room without active guest', async () => {
    const admin = await as('admin');
    const created = (await admin.post('/admin/rooms').send({ number: '401', floor: 4 })).body.data;
    const res = await admin.delete(`/admin/rooms/${created.id}`);
    expect(res.status).toBe(200);

    const check = await admin.get(`/admin/rooms/${created.id}`);
    expect(check.status).toBe(404);
  });

  it('prevents deleting a room with an active checked-in guest', async () => {
    const admin = await as('admin');
    const room = hotel.rooms[0];
    await checkIn(room.id);
    const res = await admin.delete(`/admin/rooms/${room.id}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/checked-in guest/i);
  });
});
