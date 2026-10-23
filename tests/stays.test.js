import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, as, seedHotel, api, settle } from './helpers.js';
import { db } from '../src/config/db.js';
import { outbox } from '../src/core/notifier.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { clearSettingsCache } from '../src/modules/settings/settings.service.js';
import { markNoShows } from '../src/modules/stays/stays.service.js';
import { runGuestRetention } from '../src/modules/stays/guests.service.js';
import { retryFailedRevocations } from '../src/modules/keys/keys.service.js';
import { tickRules } from '../src/modules/rules/rules.service.js';

let hotel;
beforeEach(async () => {
  await resetDb();
  hotel = await seedHotel();
});
afterAll(() => db.destroy());

const H = 3_600_000;
const inHours = (h) => new Date(Date.now() + h * H).toISOString();
const guest = { firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com' };

async function reserve(fd, overrides = {}) {
  const res = await fd.post('/admin/stays').send({ guest, roomId: hotel.rooms[0].id, arrival: inHours(-1), departure: inHours(48), ...overrides });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data.stay;
}

async function setSetting(patch) {
  for (const [key, value] of Object.entries(patch)) await db('settings').insert({ key, value: JSON.stringify(value) }).onConflict('key').merge();
  clearSettingsCache();
}

describe('reservations', () => {
  it('creates a reservation with a reference and history', async () => {
    const fd = await as('front_desk');
    const stay = await reserve(fd, { adults: 2, children: 1, notes: 'Late arrival' });
    expect(stay).toMatchObject({ status: 'reserved', source: 'manual', adults: 2, children: 1, room: { number: '101' }, guest: { firstName: 'Ada' } });
    expect(stay.reference).toMatch(/^SS[A-Z2-9]{6}$/);
    expect(stay.history[0]).toMatchObject({ action: 'created', actor: { type: 'staff' } });
    expect(stay.guests).toHaveLength(1);
  });

  it('blocks overlapping bookings for a room but allows back-to-back stays', async () => {
    const fd = await as('front_desk');
    await reserve(fd, { arrival: inHours(24), departure: inHours(72) });
    const clash = await fd.post('/admin/stays').send({ guest, roomId: hotel.rooms[0].id, arrival: inHours(48), departure: inHours(96) });
    expect(clash.status).toBe(409);
    const backToBack = await fd.post('/admin/stays').send({ guest, roomId: hotel.rooms[0].id, arrival: inHours(72), departure: inHours(96) });
    expect(backToBack.status).toBe(201);
    expect((await fd.post('/admin/stays').send({ guest, arrival: inHours(5), departure: inHours(1) })).status).toBe(400);
  });

  it('shows availability, the front desk day and searches', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd, { arrival: inHours(1), departure: inHours(24) });
    const avail = (await fd.get(`/admin/rooms/availability?from=${inHours(2)}&to=${inHours(10)}`)).body.data;
    expect(avail.rooms.map((r) => r.number)).not.toContain('101');
    expect(avail.total).toBe(5);

    const today = (await fd.get('/admin/front-desk/today')).body.data;
    expect(today.arrivals.map((a) => a.id)).toContain(s.id);
    expect(today.counts).toMatchObject({ inHouse: 0, totalRooms: 6 });

    expect((await fd.get(`/admin/stays?q=${s.reference}`)).body.data.total).toBe(1);
    expect((await fd.get('/admin/stays?q=Obi')).body.data.total).toBe(1);
    expect((await fd.get('/admin/stays?status=checked_in')).body.data.total).toBe(0);
  });

  it('cancels and marks no-shows only from reserved', async () => {
    const fd = await as('front_desk');
    const a = await reserve(fd);
    expect((await fd.post(`/admin/stays/${a.id}/cancel`).send({ reason: 'Guest called' })).body.data.status).toBe('cancelled');
    expect((await fd.post(`/admin/stays/${a.id}/check-in`)).status).toBe(400);
    const b = await reserve(fd);
    expect((await fd.post(`/admin/stays/${b.id}/no-show`)).body.data.status).toBe('no_show');
  });

  it('the no-show job closes old reservations in manual mode only', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd, { arrival: inHours(-10), departure: inHours(20) });
    await reserve(fd, { roomId: hotel.rooms[1].id, arrival: inHours(-2), departure: inHours(20) });
    expect(await markNoShows()).toBe(1);
    expect((await db('stays').where({ id: s.id }).first()).status).toBe('no_show');
    await setSetting({ booking_mode: 'pms' });
    await reserve(fd, { roomId: hotel.rooms[2].id, arrival: inHours(-10), departure: inHours(20) }).catch(() => {});
    expect(await markNoShows()).toBe(0);
  });

  it('PMS mode stops staff creating bookings', async () => {
    await setSetting({ booking_mode: 'pms' });
    const fd = await as('front_desk');
    const res = await fd.post('/admin/stays').send({ guest, roomId: hotel.rooms[0].id, arrival: inHours(1), departure: inHours(24) });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/PMS/);
  });
});

describe('check-in', () => {
  it('checks in, issues a key and an access code, emails the guest and updates the board', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd);
    const res = await fd.post(`/admin/stays/${s.id}/check-in`);
    expect(res.status).toBe(200);
    const { stay, accessCode, keys, warnings } = res.body.data;
    expect(stay).toMatchObject({ status: 'checked_in', room: { number: '101' } });
    expect(stay.checkedInAt).toBeTruthy();
    expect(accessCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(keys).toHaveLength(1);
    expect(keys[0].status).toBe('active');
    expect(warnings).toEqual([]);

    const key = await db('digital_keys').first();
    expect(MockAdapter.getKey(hotel.adapterId, key.external_key_id)).toMatchObject({ lock: 'lock-101', revoked: false });
    expect(key.credential_encrypted).not.toContain('mock');

    expect(outbox.emails[0]).toMatchObject({ to: ['ada@example.com'] });
    expect(outbox.emails[0].text).toContain(accessCode);

    const board = (await fd.get('/admin/rooms/board')).body.data;
    expect(board.floors[0].rooms.find((r) => r.number === '101')).toMatchObject({ status: 'occupied', guest: { stayId: s.id } });
  });

  it('walk-in creates and checks in at once', async () => {
    const fd = await as('front_desk');
    const res = await fd.post('/admin/stays').send({ guest, roomId: hotel.rooms[1].id, departure: inHours(24), checkInNow: true });
    expect(res.status).toBe(201);
    expect(res.body.data.stay.status).toBe('checked_in');
    expect(res.body.data.accessCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(res.body.data.qrUrl).toMatch(/^smartstay:\/\/login\?token=/);
  });

  it('allows only one of two simultaneous check-ins into the same room', async () => {
    const fd = await as('front_desk');
    const a = await reserve(fd, { roomId: undefined });
    const b = await reserve(fd, { roomId: undefined });
    const roomId = hotel.rooms[2].id;
    const results = await Promise.all([a, b].map((s) => fd.post(`/admin/stays/${s.id}/check-in`).send({ roomId })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db('stays').where({ room_id: roomId, status: 'checked_in' }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('warns when a key cannot be issued and raises a critical alert', async () => {
    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({ failKeys: true }) });
    const fd = await as('front_desk');
    const s = await reserve(fd);
    const { keys, warnings } = (await fd.post(`/admin/stays/${s.id}/check-in`)).body.data;
    expect(keys[0].status).toBe('failed');
    expect(warnings.join(' ')).toMatch(/key card/);
    expect(await db('alerts').where({ type: 'key_failed', severity: 'critical' }).first()).toBeTruthy();

    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({}) });
    const retried = (await fd.post(`/admin/stays/${s.id}/keys`)).body.data.keys;
    expect(retried[0].status).toBe('active');
  });
});

describe('during the stay', () => {
  it('moves the guest: guest requests and keys follow, maintenance stays with the room', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd);
    await fd.post(`/admin/stays/${s.id}/check-in`);
    const service = await as('service');
    const towels = (await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'housekeeping' })).body.data;
    const leak = (await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'maintenance' })).body.data;

    const moved = await fd.post(`/admin/stays/${s.id}/move`).send({ roomId: hotel.rooms[1].id, reason: 'AC broken' });
    expect(moved.status).toBe(200);
    expect(moved.body.data.stay.room.number).toBe('102');
    expect(moved.body.data.keys[0]).toMatchObject({ status: 'active', roomId: hotel.rooms[1].id });

    expect((await db('requests').where({ id: towels.id }).first()).room_id).toBe(hotel.rooms[1].id);
    expect((await db('requests').where({ id: leak.id }).first()).room_id).toBe(hotel.rooms[0].id);
    const keys = await db('digital_keys').where({ stay_id: s.id }).orderBy('id');
    expect(keys.map((k) => k.status)).toEqual(['revoked', 'active']);

    // Can't move into an occupied room
    const other = await reserve(fd, { roomId: hotel.rooms[2].id });
    await fd.post(`/admin/stays/${other.id}/check-in`);
    expect((await fd.post(`/admin/stays/${s.id}/move`).send({ roomId: hotel.rooms[2].id })).status).toBe(409);
  });

  it('extends the stay and the key, but not into the next booking', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd, { departure: inHours(24) });
    await fd.post(`/admin/stays/${s.id}/check-in`);
    await reserve(fd, { arrival: inHours(48), departure: inHours(72) });

    expect((await fd.post(`/admin/stays/${s.id}/extend`).send({ departure: inHours(60) })).status).toBe(409);
    const ok = await fd.post(`/admin/stays/${s.id}/extend`).send({ departure: inHours(47) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.history.at(-1).action).toBe('extended');
    const key = await db('digital_keys').where({ stay_id: s.id, status: 'active' }).first();
    expect(new Date(key.valid_until).getTime()).toBeGreaterThan(Date.now() + 46 * H);
    expect(MockAdapter.getKey(hotel.adapterId, key.external_key_id).validUntil.getTime()).toBe(new Date(key.valid_until).getTime());
  });

  it('only lets checked-in stays change room through move', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd);
    await fd.post(`/admin/stays/${s.id}/check-in`);
    expect((await fd.patch(`/admin/stays/${s.id}`).send({ roomId: hotel.rooms[3].id })).status).toBe(400);
    expect((await fd.patch(`/admin/stays/${s.id}`).send({ adults: 3, addGuests: [{ firstName: 'Tobi', lastName: 'Obi' }] })).body.data).toMatchObject({ adults: 3 });
  });
});

describe('check-out', () => {
  it('revokes keys and guest access, closes guest requests and frees the room', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd);
    const { accessCode } = (await fd.post(`/admin/stays/${s.id}/check-in`)).body.data;
    const session = (await api().post('/guest/login').send({ bookingCode: accessCode })).body.data;
    await api().put('/guest/push-token').set('Authorization', `Bearer ${session.token}`).send({ pushToken: 'push-token-123', platform: 'android' });
    const service = await as('service');
    const towels = (await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'housekeeping' })).body.data;
    const leak = (await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'maintenance' })).body.data;
    await db('rooms').where({ id: hotel.rooms[0].id }).update({ dnd: true });

    const out = await fd.post(`/admin/stays/${s.id}/check-out`).send({ note: 'Paid in full' });
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ keysRevoked: 1, keysFailed: 0, requestsClosed: 1, stay: { status: 'checked_out' } });

    const key = await db('digital_keys').where({ stay_id: s.id }).first();
    expect(MockAdapter.getKey(hotel.adapterId, key.external_key_id).revoked).toBe(true);
    expect((await api().get('/guest/me').set('Authorization', `Bearer ${session.token}`)).status).toBe(401);
    expect(await db('guest_devices').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect((await db('requests').where({ id: towels.id }).first()).status).toBe('cancelled');
    expect((await db('requests').where({ id: leak.id }).first()).status).toBe('new');
    expect((await db('rooms').where({ id: hotel.rooms[0].id }).first()).dnd).toBe(false);
    expect((await fd.post(`/admin/stays/${s.id}/check-out`)).status).toBe(400);
  });

  it('keeps retrying keys that could not be revoked', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd);
    await fd.post(`/admin/stays/${s.id}/check-in`);
    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({ failRevoke: true }) });
    const out = (await fd.post(`/admin/stays/${s.id}/check-out`)).body.data;
    expect(out.keysFailed).toBe(1);
    expect(await db('alerts').where({ type: 'key_revoke_failed', severity: 'critical' }).first()).toBeTruthy();

    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({}) });
    expect(await retryFailedRevocations()).toBe(1);
    expect((await db('digital_keys').where({ stay_id: s.id }).first()).status).toBe('revoked');
  });

  it('vacancy rules use the real check-out time', async () => {
    const admin = await as('admin');
    await admin.post('/admin/rules').send({ name: 'Eco', type: 'vacancy', target: { scope: 'rooms', roomIds: [hotel.rooms[0].id] }, conditions: { trigger: 'unsold', delayMinutes: 30 }, actions: [{ type: 'set_climate', mode: 'eco' }] });
    const fd = await as('front_desk');
    const s = await reserve(fd);
    await fd.post(`/admin/stays/${s.id}/check-in`);
    await fd.post(`/admin/stays/${s.id}/check-out`);
    expect(await tickRules()).toHaveLength(0); // checked out just now: inside the 30 minute delay
    await db('stays').where({ id: s.id }).update({ checked_out_at: new Date(Date.now() - 31 * 60_000) });
    expect((await tickRules())[0]).toMatchObject({ roomsMatched: 1 });
  });
});

describe('guest profiles and privacy', () => {
  it('hides guest contact details from roles that do not manage stays', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd);
    await fd.post(`/admin/stays/${s.id}/check-in`);
    const forService = (await (await as('service')).get(`/admin/rooms/${hotel.rooms[0].id}`)).body.data.stay;
    const forDesk = (await fd.get(`/admin/rooms/${hotel.rooms[0].id}`)).body.data.stay;
    expect(forService.guest).toEqual({ id: s.guest.id, firstName: 'Ada', language: null, vip: false });
    expect(forService.reference).toBeUndefined();
    expect(forDesk.guest).toMatchObject({ email: 'ada@example.com', lastName: 'Obi' });
  });

  it('anonymises only after the stay ends, and retention does it automatically', async () => {
    const fd = await as('front_desk');
    const admin = await as('admin');
    const s = await reserve(fd);
    expect((await admin.post(`/admin/guests/${s.guest.id}/anonymise`)).status).toBe(409);
    await fd.post(`/admin/stays/${s.id}/check-in`);
    await fd.post(`/admin/stays/${s.id}/check-out`);
    const anon = (await admin.post(`/admin/guests/${s.guest.id}/anonymise`)).body.data;
    expect(anon).toMatchObject({ firstName: 'Anonymised', lastName: null, email: null, anonymized: true });
    expect(anon.stays).toHaveLength(1);
    expect((await fd.patch(`/admin/guests/${s.guest.id}`).send({ firstName: 'X' })).status).toBe(400);

    const g2 = (await fd.post('/admin/guests').send({ firstName: 'Old', lastName: 'Guest' })).body.data;
    await db('guests').where({ id: g2.id }).update({ created_at: new Date(Date.now() - 400 * 86_400_000) });
    expect(await runGuestRetention()).toBe(1);
    expect((await db('guests').where({ id: g2.id }).first()).first_name).toBe('Anonymised');
  });

  it('searches guests and shows their stay history', async () => {
    const fd = await as('front_desk');
    const s = await reserve(fd);
    const list = (await fd.get('/admin/guests?q=ada@')).body.data;
    expect(list.items[0]).toMatchObject({ firstName: 'Ada' });
    expect((await fd.get(`/admin/guests?q=${s.reference}`)).body.data.total).toBe(1);
    const detail = (await fd.get(`/admin/guests/${s.guest.id}`)).body.data;
    expect(detail.stays[0].reference).toBe(s.reference);
    await settle();
  });
});
