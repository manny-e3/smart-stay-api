import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, as, seedHotel, api } from './helpers.js';
import { db } from '../src/config/db.js';
import { MockPms } from '../src/pms/index.js';
import { clearSettingsCache } from '../src/modules/settings/settings.service.js';

let hotel;
let admin;
let conn;
let secret;
beforeEach(async () => {
  await resetDb();
  hotel = await seedHotel();
  admin = await as('admin');
  conn = (await admin.post('/admin/pms/connections').send({ name: 'Hotel PMS', vendor: 'mock', config: { apiKey: 'pms-secret-key' } })).body.data;
  secret = (await admin.post(`/admin/pms/connections/${conn.id}/secret`)).body.data.webhookSecret;
});
afterAll(() => db.destroy());

const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
// Fixed once, like a real PMS sending the same reservation in every event.
const ARRIVAL = inHours(-1);
const DEPARTURE = inHours(48);
const reservation = (overrides = {}) => ({
  externalId: 'R-1001',
  roomCode: '101',
  arrival: ARRIVAL,
  departure: DEPARTURE,
  adults: 2,
  guest: { externalId: 'G-77', firstName: 'Kemi', lastName: 'Ade', email: 'kemi@example.com' },
  ...overrides,
});
const send = (events, s = secret) => api().post(`/integrations/pms/${conn.id}/events`).set('X-PMS-Secret', s).send({ events });
let n = 0;
const ev = (type, res = reservation(), extra = {}) => ({ eventId: `e-${++n}`, type, occurredAt: new Date(Date.now() + n).toISOString(), reservation: res, ...extra });

describe('PMS webhook', () => {
  it('needs the secret', async () => {
    expect((await send([ev('reservation.upsert')], 'wrong')).status).toBe(401);
  });

  it('creates, checks in and checks out from PMS events', async () => {
    const created = await send([ev('reservation.upsert')]);
    expect(created.status).toBe(202);
    const stay = await db('stays').where({ external_id: 'R-1001' }).first();
    expect(stay).toMatchObject({ status: 'reserved', source: 'pms', adults: 2, room_id: hotel.rooms[0].id });

    const checkIn = (await send([ev('stay.checked_in')])).body.data.results[0];
    expect(checkIn).toMatchObject({ status: 'processed', result: 'checked in' });
    expect(await db('digital_keys').where({ stay_id: stay.id, status: 'active' }).first()).toBeTruthy();

    const moved = (await send([ev('stay.room_moved', reservation({ roomCode: '102' }))])).body.data.results[0];
    expect(moved.result).toBe('moved');

    const out = (await send([ev('stay.checked_out', reservation({ roomCode: '102' }))])).body.data.results[0];
    expect(out.result).toBe('checked out');
    const history = (await admin.get(`/admin/stays/${stay.id}`)).body.data.history.map((h) => `${h.action}:${h.actor.type}`);
    expect(history).toEqual(['created:pms', 'checked_in:pms', 'moved:pms', 'checked_out:pms']);
  });

  it('processes each event id once and ignores stale events', async () => {
    const e = ev('reservation.upsert');
    await send([e]);
    expect((await send([e])).body.data.results[0].status).toBe('duplicate');
    await send([ev('stay.checked_in')]);
    const stale = { eventId: 'old-1', type: 'reservation.cancelled', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), reservation: reservation() };
    expect((await send([stale])).body.data.results[0]).toMatchObject({ status: 'ignored' });
    expect((await db('stays').where({ external_id: 'R-1001' }).first()).status).toBe('checked_in');
  });

  it('handles a check-in that arrives before the reservation', async () => {
    const res = (await send([ev('stay.checked_in', reservation({ externalId: 'R-2002' }))])).body.data.results[0];
    expect(res.result).toBe('checked in');
    expect((await db('stays').where({ external_id: 'R-2002' }).first()).status).toBe('checked_in');
  });

  it('records failed events with an alert and retries them after a fix', async () => {
    const res = (await send([ev('reservation.upsert', reservation({ roomCode: 'PMS-101' }))])).body.data.results[0];
    expect(res.status).toBe('failed');
    expect(await db('alerts').where({ type: 'pms_sync_failed' }).first()).toBeTruthy();

    await db('rooms').where({ id: hotel.rooms[0].id }).update({ pms_code: 'PMS-101' });
    const failed = (await admin.get('/admin/pms/events?status=failed')).body.data.items[0];
    const retried = (await admin.post(`/admin/pms/events/${failed.id}/retry`)).body.data;
    expect(retried.status).toBe('processed');
    expect((await db('stays').where({ external_id: 'R-1001' }).first()).room_id).toBe(hotel.rooms[0].id);
  });

  it('keeps guest profiles linked by PMS id', async () => {
    await send([ev('reservation.upsert')]);
    await send([ev('reservation.upsert', reservation({ externalId: 'R-3003', roomCode: '103', guest: { externalId: 'G-77', firstName: 'Kemi', lastName: 'Adebayo' } }))]);
    const guests = await db('guests').where({ external_id: 'G-77' });
    expect(guests).toHaveLength(1);
    expect(guests[0].last_name).toBe('Adebayo');
  });
});

describe('reconciliation', () => {
  it('checks in guests the PMS has in-house and checks out ones it no longer has', async () => {
    await send([ev('reservation.upsert', reservation({ externalId: 'R-OLD', roomCode: '103' })), ev('stay.checked_in', reservation({ externalId: 'R-OLD', roomCode: '103' }))]);
    // A manual walk-in is not touched by reconciliation
    const fd = await as('front_desk');
    await fd.post('/admin/stays').send({ guest: { firstName: 'Walk', lastName: 'In' }, roomId: hotel.rooms[4].id, departure: inHours(24), checkInNow: true });

    MockPms.setInHouse(conn.id, [reservation({ externalId: 'R-NEW', roomCode: '102' })]);
    const { summary, connection } = (await admin.post(`/admin/pms/connections/${conn.id}/sync`)).body.data;
    expect(summary).toMatchObject({ checkedIn: 1, checkedOut: 1, failed: 0 });
    expect(connection).toMatchObject({ status: 'healthy', config: { apiKey: '********' } });
    expect((await db('stays').where({ external_id: 'R-OLD' }).first()).status).toBe('checked_out');
    expect((await db('stays').where({ external_id: 'R-NEW' }).first()).status).toBe('checked_in');
    expect(await db('stays').where({ source: 'manual', status: 'checked_in' }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('reports an unreachable PMS', async () => {
    await admin.patch(`/admin/pms/connections/${conn.id}`).send({ config: { simulateDown: true, apiKey: '********' } });
    expect((await admin.post(`/admin/pms/connections/${conn.id}/sync`)).status).toBe(502);
    expect((await db('pms_connections').where({ id: conn.id }).first()).config.apiKey).toBe('pms-secret-key');
  });

  it('marks staff changes in PMS mode as manual overrides', async () => {
    await db('settings').insert({ key: 'booking_mode', value: JSON.stringify('pms') }).onConflict('key').merge();
    clearSettingsCache();
    await send([ev('reservation.upsert')]);
    const stay = await db('stays').where({ external_id: 'R-1001' }).first();
    const fd = await as('front_desk');
    expect((await fd.post(`/admin/stays/${stay.id}/check-in`)).status).toBe(200);
    const last = (await fd.get(`/admin/stays/${stay.id}`)).body.data.history.at(-1);
    expect(last).toMatchObject({ action: 'checked_in', actor: { type: 'staff' }, data: { manualOverride: true } });
  });
});
