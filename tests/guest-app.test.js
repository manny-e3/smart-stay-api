import http from 'node:http';
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { io as connect } from 'socket.io-client';
import { app, resetDb, as, seedHotel, api, tokenFor, settle } from './helpers.js';
import { db } from '../src/config/db.js';
import { outbox } from '../src/core/notifier.js';
import { clearSettingsCache } from '../src/modules/settings/settings.service.js';
import { tickRules } from '../src/modules/rules/rules.service.js';
import { initSockets, closeSockets } from '../src/core/sockets.js';
import { registerListeners } from '../src/core/listeners.js';

let hotel;
let fd;
beforeEach(async () => {
  await resetDb();
  hotel = await seedHotel({ guestDevices: true });
  fd = await as('front_desk');
});

let server;
let url;
beforeAll(async () => {
  server = http.createServer(app);
  initSockets(server);
  registerListeners();
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
afterAll(async () => {
  await closeSockets();
  await new Promise((r) => server.close(r));
  await db.destroy();
});

const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function setSetting(patch) {
  for (const [key, value] of Object.entries(patch)) await db('settings').insert({ key, value: JSON.stringify(value) }).onConflict('key').merge();
  clearSettingsCache();
}

async function checkedInStay(roomIndex = 0, guest = { firstName: 'Chika', lastName: 'Nwàchukwu', email: 'chika@example.com' }) {
  const stay = (await fd.post('/admin/stays').send({ guest, companions: [{ firstName: 'Bayo', lastName: 'Adeyemi' }], roomId: hotel.rooms[roomIndex].id, arrival: inHours(-1), departure: inHours(48) })).body.data.stay;
  const checkIn = (await fd.post(`/admin/stays/${stay.id}/check-in`)).body.data;
  return { stay, ...checkIn };
}

const guestApi = (token) => {
  const wrap = (m) => (path) => api()[m](path).set('Authorization', `Bearer ${token}`);
  return { token, get: wrap('get'), post: wrap('post'), put: wrap('put'), delete: wrap('delete') };
};

async function login(body) {
  const res = await api().post('/guest/login').send(body);
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return guestApi(res.body.data.token);
}

const deviceOf = (roomIndex, type, name) => db('devices').where({ room_id: hotel.rooms[roomIndex].id, type, ...(name ? { name } : {}) }).first();

/* ------------------------------------------------------------------ login */

describe('login', () => {
  it('signs in with the booking code, typed loosely', async () => {
    const { accessCode } = await checkedInStay();
    const typed = `${accessCode.slice(0, 4).toLowerCase()}-${accessCode.slice(4)} `;
    const g = await login({ bookingCode: typed });
    const me = (await g.get('/guest/me')).body.data;
    expect(me).toMatchObject({ room: { number: '101' }, guest: { firstName: 'Chika' }, roomStatus: { dnd: false, cleaningRequested: false }, key: { available: true }, eco: { active: false } });
  });

  it('signs in with the QR token and with reference + any guest last name', async () => {
    const { stay, qrToken, qrUrl } = await checkedInStay();
    expect(qrUrl).toContain(encodeURIComponent(qrToken));
    await login({ qrToken });
    const companion = await login({ reference: stay.reference.toLowerCase(), lastName: 'ADEYEMI' });
    expect((await companion.get('/guest/me')).body.data.guest.firstName).toBe('Bayo');
  });

  it('emails the booking code and login link at check-in', async () => {
    const { accessCode, qrUrl } = await checkedInStay();
    const mail = outbox.emails.find((e) => e.to.includes('chika@example.com'));
    expect(mail.text).toContain(accessCode);
    expect(mail.text).toContain(qrUrl);
  });

  it('rejects wrong details with one message and tells reservations to wait', async () => {
    const { stay } = await checkedInStay();
    const a = await api().post('/guest/login').send({ bookingCode: 'ZZZZZZZZ' });
    const b = await api().post('/guest/login').send({ reference: stay.reference, lastName: 'Smith' });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body.message).toBe(b.body.message);
    const future = (await fd.post('/admin/stays').send({ guest: { firstName: 'Ife', lastName: 'Bello' }, roomId: hotel.rooms[3].id, arrival: inHours(5), departure: inHours(48) })).body.data.stay;
    expect((await api().post('/guest/login').send({ reference: future.reference, lastName: 'Bello' })).body.code).toBe('NOT_CHECKED_IN');
  });

  it('limits phones per room and frees a slot on logout', async () => {
    await setSetting({ phones_per_room: 2 });
    const { accessCode } = await checkedInStay();
    const one = await login({ bookingCode: accessCode });
    await login({ bookingCode: accessCode });
    const third = await api().post('/guest/login').send({ bookingCode: accessCode });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('DEVICE_LIMIT');
    await one.post('/guest/logout');
    expect((await api().post('/guest/login').send({ bookingCode: accessCode })).status).toBe(201);
  });

  it('a new code stops the old code, the old QR and signed-in phones', async () => {
    const { stay, accessCode, qrToken } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    const fresh = (await fd.post(`/admin/stays/${stay.id}/access-code`).send({ signOutDevices: true })).body.data;
    expect(fresh.accessCode).not.toBe(accessCode);
    expect((await g.get('/guest/me')).body.code).toBe('GUEST_SESSION_ENDED');
    expect((await api().post('/guest/login').send({ bookingCode: accessCode })).status).toBe(401);
    expect((await api().post('/guest/login').send({ qrToken })).status).toBe(401);
    expect((await api().post('/guest/login').send({ qrToken: fresh.qrToken })).status).toBe(201);
  });

  it('serves help content without signing in', async () => {
    await setSetting({ reception_phone: '+234 1 000 0000', guest_faqs: [{ question: 'Wi-Fi?', answer: 'SmartStay-Guest' }], privacy_notice: 'We keep your data for 365 days.' });
    const info = (await api().get('/guest/info')).body.data;
    expect(info).toMatchObject({ receptionPhone: '+234 1 000 0000', faqs: [{ question: 'Wi-Fi?' }], privacyNotice: expect.stringContaining('365') });
  });

  it('guest and staff tokens are not interchangeable', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    expect((await api().get('/admin/rooms/board').set('Authorization', `Bearer ${g.token}`)).status).toBe(401);
    expect((await api().get('/guest/me').set('Authorization', `Bearer ${await tokenFor('admin')}`)).status).toBe(401);
  });
});

/* ------------------------------------------------------------- digital key */

describe('digital key', () => {
  it('returns the credential and unlock methods inside the stay window only', async () => {
    const { accessCode, stay } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    const key = (await g.get('/guest/key')).body.data;
    expect(key.methods).toEqual({ ble: true, remote: true });
    expect(key.keys[0]).toMatchObject({ doorName: 'lock', credential: { type: 'mock' } });

    await db('digital_keys').where({ stay_id: stay.id }).update({ valid_from: new Date(Date.now() + 3_600_000) });
    const early = await g.get('/guest/key');
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('KEY_NOT_ACTIVE');
    expect((await g.get('/guest/me')).body.data.key.available).toBe(false);
  });

  it('unlocks from the cloud, logs it, and reports a lock that does not open', async () => {
    const { accessCode, stay } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    expect((await g.post('/guest/key/unlock').send({})).status).toBe(200);
    const log = (await (await as('manager')).get('/admin/audit?action=room.unlock')).body.data.items[0];
    expect(log).toMatchObject({ actor: { type: 'guest', id: stay.guest.id }, details: { method: 'mobile_app', success: true } });

    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({ simulateDown: true }) });
    const res = await g.post('/guest/key/unlock').send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UNLOCK_FAILED');
  });

  it('cannot open another room’s door; the key follows a room move', async () => {
    const a = await checkedInStay(0);
    const g = await login({ bookingCode: a.accessCode });
    const otherLock = await deviceOf(1, 'lock');
    expect((await g.post('/guest/key/unlock').send({ deviceId: otherLock.id })).status).toBe(403);
    await fd.post(`/admin/stays/${a.stay.id}/move`).send({ roomId: hotel.rooms[2].id });
    expect((await g.post('/guest/key/unlock').send({})).body.data.deviceId).toBe((await deviceOf(2, 'lock')).id);
  });
});

/* ------------------------------------------------------------ room controls */

describe('room controls', () => {
  it('lists only guest devices with capabilities and the hotel AC range', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    const { devices, eco } = (await g.get('/guest/devices')).body.data;
    expect(devices.map((d) => d.type)).toEqual(['light', 'light', 'thermostat', 'curtain', 'tv', 'speaker']);
    expect(eco.active).toBe(false);
    const ac = devices.find((d) => d.type === 'thermostat');
    expect(ac.capabilities).toMatchObject({ minTemp: 18, maxTemp: 28, modes: expect.arrayContaining(['cool']) });
    expect(ac.state).toEqual({ mode: 'cool', setpoint: 22 });
    expect(devices.find((d) => d.name === 'Bedside').capabilities.dimmable).toBe(true);
  });

  it('applies valid commands and returns the new state', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    const bedside = await deviceOf(0, 'light', 'Bedside');
    const ac = await deviceOf(0, 'thermostat');
    const curtain = await deviceOf(0, 'curtain');
    const tv = await deviceOf(0, 'tv');

    const light = (await g.post(`/guest/devices/${bedside.id}/command`).send({ brightness: 40 })).body.data;
    expect(light.device.state).toEqual({ on: true, brightness: 40 });
    expect(typeof light.latencyMs).toBe('number');
    expect((await g.post(`/guest/devices/${ac.id}/command`).send({ setpoint: 24.5, fan: 'low' })).body.data.device.state).toMatchObject({ setpoint: 24.5, fan: 'low', mode: 'cool' });
    expect((await g.post(`/guest/devices/${curtain.id}/command`).send({ action: 'open' })).body.data.device.state).toMatchObject({ position: 100 });
    expect((await g.post(`/guest/devices/${tv.id}/command`).send({ power: true, input: 'hdmi1', volume: 30 })).body.data.device.state).toMatchObject({ power: true, input: 'hdmi1', volume: 30 });
  });

  it('enforces hotel limits and device capabilities', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    const send = async (type, name, body) => (await g.post(`/guest/devices/${(await deviceOf(0, type, name)).id}/command`).send(body)).status;
    expect(await send('thermostat', null, { setpoint: 30 })).toBe(400);
    expect(await send('thermostat', null, { setpoint: 22.3 })).toBe(400);
    expect(await send('thermostat', null, { mode: 'eco' })).toBe(400);
    expect(await send('light', 'Ceiling', { brightness: 50 })).toBe(400);
    expect(await send('curtain', null, { action: 'open', position: 20 })).toBe(400);
    expect(await send('tv', null, { input: 'hdmi3' })).toBe(400);
    expect(await send('light', 'Ceiling', {})).toBe(400);
    expect(await send('light', 'Ceiling', { on: true, colour: 'red' })).toBe(400);
  });

  it("can't reach other rooms or locks, and reports offline or failing devices", async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    expect((await g.post(`/guest/devices/${(await deviceOf(1, 'light', 'Ceiling')).id}/command`).send({ on: true })).status).toBe(404);
    expect((await g.post(`/guest/devices/${(await deviceOf(0, 'lock')).id}/command`).send({ on: true })).status).toBe(404);

    const ceiling = await deviceOf(0, 'light', 'Ceiling');
    await db('device_states').where({ device_id: ceiling.id }).update({ online: false });
    expect((await g.post(`/guest/devices/${ceiling.id}/command`).send({ on: true })).body.code).toBe('DEVICE_OFFLINE');

    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({ failCommands: true }) });
    const tv = await deviceOf(0, 'tv');
    const failed = await g.post(`/guest/devices/${tv.id}/command`).send({ power: true });
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('COMMAND_FAILED');
    expect(await db('alerts').where({ type: 'command_failed', device_id: tv.id }).first()).toBeTruthy();
  });

  it('shows eco, ends it on a guest change, and keeps the rule away for the delay', async () => {
    const admin = await as('admin');
    await admin.post('/admin/rules').send({ name: 'Eco when away', type: 'vacancy', target: { scope: 'all' }, conditions: { trigger: 'no_presence', delayMinutes: 30 }, actions: [{ type: 'set_climate', mode: 'eco' }] });
    const { accessCode } = await checkedInStay();
    const sensor = await deviceOf(0, 'sensor');
    await db('device_states').where({ device_id: sensor.id }).update({ state: JSON.stringify({ presence: false, presenceChangedAt: new Date(Date.now() - 3_600_000).toISOString() }) });
    await tickRules();

    const g = await login({ bookingCode: accessCode });
    const me = (await g.get('/guest/me')).body.data;
    expect(me.eco).toMatchObject({ active: true, setpoint: 26 });
    const ac = await deviceOf(0, 'thermostat');
    const after = (await g.post(`/guest/devices/${ac.id}/command`).send({ setpoint: 21 })).body.data.device;
    expect(after).toMatchObject({ eco: false, state: { mode: 'cool', setpoint: 21 } });

    expect(await tickRules()).toEqual([]); // the guest just took over: no eco for 30 minutes
    expect((await g.get('/guest/me')).body.data.eco.active).toBe(false);
  });
});

/* -------------------------------------------------------------- room status */

describe('room status', () => {
  it('cleaning request goes to the queue and the board; DND cancels it', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    await db('rooms').where({ id: hotel.rooms[0].id }).update({ dnd: true });

    const status = (await g.put('/guest/room-status').send({ cleaningRequested: true })).body.data;
    expect(status).toMatchObject({ dnd: false, cleaningRequested: true });
    const service = await as('service');
    const queue = (await service.get('/admin/requests?status=new')).body.data.items;
    expect(queue[0]).toMatchObject({ category: 'housekeeping', source: 'guest', room: { number: '101' } });
    const board = (await service.get('/admin/rooms/board')).body.data;
    expect(board.floors[0].rooms.find((r) => r.number === '101').cleaningRequested).toBe(true);

    expect((await g.put('/guest/room-status').send({ dnd: true })).body.data).toMatchObject({ dnd: true, cleaningRequested: false });
    expect((await db('requests').where({ id: queue[0].id }).first()).status).toBe('cancelled');
    expect((await g.put('/guest/room-status').send({ dnd: true, cleaningRequested: true })).status).toBe(400);
  });

  it('finishing the cleaning request clears the flag', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    await g.put('/guest/room-status').send({ cleaningRequested: true });
    const room = await db('rooms').where({ id: hotel.rooms[0].id }).first();
    await (await as('service')).patch(`/admin/requests/${room.cleaning_request_id}`).send({ status: 'done' });
    expect((await g.get('/guest/me')).body.data.roomStatus.cleaningRequested).toBe(false);
  });
});

/* ----------------------------------------------------------------- requests */

describe('requests', () => {
  it('creates with a preferred time, shows a timeline without staff names, and cancels', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    expect((await g.post('/guest/requests').send({ category: 'food', preferredAt: inHours(100) })).status).toBe(400);
    const created = (await g.post('/guest/requests').send({ category: 'amenities', description: 'Water', preferredAt: inHours(2) })).body.data;
    expect(created).toMatchObject({ status: 'new', canCancel: true, preferredAt: expect.any(String) });

    const staffView = (await (await as('service')).get(`/admin/requests/${created.id}`)).body.data;
    expect(staffView.preferredAt).toBeTruthy();

    const service = await as('service');
    await service.patch(`/admin/requests/${created.id}`).send({ assignedTo: (await db('staff').where({ role: 'service' }).first()).id, note: 'internal note' });
    const detail = (await g.get(`/guest/requests/${created.id}`)).body.data;
    expect(detail.timeline.map((t) => t.event)).toEqual(['created', 'assigned']);
    expect(JSON.stringify(detail)).not.toMatch(/internal note|Test service/);

    const cancelled = (await g.post(`/guest/requests/${created.id}/cancel`)).body.data;
    expect(cancelled).toMatchObject({ status: 'cancelled', canCancel: false });
    expect(cancelled.timeline.at(-1)).toMatchObject({ event: 'cancelled', by: 'you' });
  });

  it("can't cancel once in progress, or touch another stay's request", async () => {
    const a = await checkedInStay(0);
    const b = await checkedInStay(1, { firstName: 'Musa', lastName: 'Bello' });
    const ga = await login({ bookingCode: a.accessCode });
    const gb = await login({ bookingCode: b.accessCode });
    const r = (await ga.post('/guest/requests').send({ category: 'laundry' })).body.data;
    expect((await gb.get(`/guest/requests/${r.id}`)).status).toBe(404);
    expect((await gb.post(`/guest/requests/${r.id}/cancel`)).status).toBe(404);
    await (await as('service')).patch(`/admin/requests/${r.id}`).send({ status: 'in_progress' });
    const res = await ga.post(`/guest/requests/${r.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already working/);
  });

  it('pushes status changes to the registered phone', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    await g.put('/guest/push-token').send({ pushToken: 'fcm-token-abcdef', platform: 'ios' });
    const r = (await g.post('/guest/requests').send({ category: 'housekeeping' })).body.data;
    await (await as('service')).patch(`/admin/requests/${r.id}`).send({ status: 'in_progress' });
    expect(outbox.guestPush.at(-1)).toMatchObject({ devices: 1, data: { status: 'in_progress' } });
  });
});

/* ----------------------------------------------------------------- feedback */

describe('feedback', () => {
  it('uploads photos privately, marks as issue, and staff see signed links', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    const res = await api()
      .post('/guest/feedback')
      .set('Authorization', `Bearer ${g.token}`)
      .field('rating', '2')
      .field('comment', 'Shower is leaking')
      .field('markAsIssue', 'true')
      .attach('photos', PNG, { filename: 'leak.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ photos: 1, markedAsIssue: true });

    const alert = await db('alerts').where({ type: 'guest_issue', feedback_id: res.body.data.id }).first();
    expect(alert).toMatchObject({ source: 'guest', message: 'Shower is leaking' });

    const item = (await (await as('manager')).get('/admin/feedback')).body.data.items[0];
    expect(item.isIssue).toBe(true);
    const photoUrl = item.photos[0].url;
    expect(photoUrl).toMatch(/^\/media\/feedback-photos\/\d+\?exp=\d+&sig=/);
    const img = await api().get(photoUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await api().get(photoUrl.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(403);
    expect((await api().get(photoUrl.replace(/exp=\d+/, 'exp=9999999999'))).status).toBe(403);
    expect((await api().get(`/uploads/${(await db('feedback_photos').first()).storage_key}`)).status).toBe(404);
  });

  it('rejects files that are not images and accepts plain JSON feedback', async () => {
    const { accessCode } = await checkedInStay();
    const g = await login({ bookingCode: accessCode });
    const bad = await api().post('/guest/feedback').set('Authorization', `Bearer ${g.token}`).field('rating', '4').attach('photos', Buffer.from('<svg onload=alert(1)>'), { filename: 'x.png', contentType: 'image/png' });
    expect(bad.status).toBe(400);
    expect(await db('feedback').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect((await g.post('/guest/feedback').send({ rating: 5, comment: 'Great' })).status).toBe(201);
  });
});

/* -------------------------------------------------------------- preferences */

describe('preferences', () => {
  it('saves, validates and applies preferences now or at the next check-in', async () => {
    const first = await checkedInStay();
    const g = await login({ bookingCode: first.accessCode });
    expect((await g.get('/guest/preferences')).body.data.preferences).toEqual({});
    expect((await g.put('/guest/preferences').send({ preferences: { temperature: { setpoint: 33 } } })).status).toBe(400);

    const saved = (await g.put('/guest/preferences').send({ preferences: { temperature: { setpoint: 20, fan: 'low' }, lights: { brightness: 30 }, music: { volume: 15, autoplay: false } }, applyNow: true })).body.data;
    // AC, the dimmable light and the speaker. The ceiling light can't dim, so a brightness-only preference leaves it alone.
    expect(saved.applied).toMatchObject({ applied: 3, failed: 0 });
    const ac = await db('device_states').where({ device_id: (await deviceOf(0, 'thermostat')).id }).first();
    expect(ac.state).toMatchObject({ setpoint: 20, fan: 'low' });

    // Next stay: preferences are applied automatically at check-in.
    await fd.post(`/admin/stays/${first.stay.id}/check-out`);
    const again = (await fd.post('/admin/stays').send({ guest: { id: first.stay.guest.id }, roomId: hotel.rooms[3].id, departure: inHours(24), checkInNow: true })).body.data;
    expect(again.preferences).toMatchObject({ failed: 0 });
    const ac2 = await db('device_states').where({ device_id: (await deviceOf(3, 'thermostat')).id }).first();
    expect(ac2.state).toMatchObject({ setpoint: 20 });
  });
});

/* ---------------------------------------------------------- live updates */

describe('guest live channel', () => {
  const open = (token) =>
    new Promise((resolve, reject) => {
      const s = connect(`${url}/guest`, { auth: { token }, transports: ['websocket'], reconnection: false });
      s.on('ready', () => resolve(s));
      s.on('connect_error', (err) => {
        s.close();
        reject(err);
      });
    });
  const next = (socket, event) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 3000);
      socket.once(event, (d) => {
        clearTimeout(t);
        resolve(d);
      });
    });

  it('sends device state and room status to the stay only, and ends on check-out', async () => {
    const a = await checkedInStay(0);
    const b = await checkedInStay(1, { firstName: 'Musa', lastName: 'Bello' });
    const ga = await login({ bookingCode: a.accessCode });
    const gb = await login({ bookingCode: b.accessCode });
    const sa = await open(ga.token);
    const sb = await open(gb.token);
    let bGotSomething = false;
    sb.on('device:state', () => (bGotSomething = true));

    const state = next(sa, 'device:state');
    await ga.post(`/guest/devices/${(await deviceOf(0, 'light', 'Ceiling')).id}/command`).send({ on: true });
    expect(await state).toMatchObject({ name: 'Ceiling', state: { on: true } });

    const status = next(sa, 'room:status');
    await ga.put('/guest/room-status').send({ dnd: true });
    expect(await status).toMatchObject({ dnd: true, cleaningRequested: false });
    await settle(300);
    expect(bGotSomething).toBe(false);

    const ended = next(sa, 'session:ended');
    await fd.post(`/admin/stays/${a.stay.id}/check-out`);
    expect(await ended).toEqual({ reason: 'checked_out' });
    sb.close();
  });

  it('refuses staff tokens', async () => {
    await expect(open(await tokenFor('admin'))).rejects.toThrow();
  });
});
