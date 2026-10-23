import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { db } from '../src/config/db.js';
import { ROLES } from '../src/core/permissions.js';
import { outbox } from '../src/core/notifier.js';
import { clearSettingsCache, DEFAULT_SETTINGS } from '../src/modules/settings/settings.service.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { MockPms } from '../src/pms/index.js';

export const app = createApp();
export const api = () => request(app);
export const PASSWORD = 'TestPassword123';

const TABLES = [
  'guest_preferences', 'pms_events', 'pms_connections', 'digital_keys', 'guest_sessions', 'guest_access_codes', 'stay_events', 'stay_guests',
  'energy_readings', 'rule_runs', 'rules', 'audit_log', 'push_subscriptions', 'settings', 'alert_occurrences', 'alerts',
  'feedback_photos', 'feedback', 'request_events', 'requests', 'guest_devices', 'stays', 'guests', 'device_events',
  'device_states', 'devices', 'adapters', 'rooms', 'room_types', 'floors', 'sessions', 'staff',
];

let passwordHash;

/** Empties every table and creates one staff member per role. Returns staff rows keyed by role. */
export async function resetDb() {
  // FOREIGN_KEY_CHECKS is per connection, so every statement must use the same pooled connection.
  const conn = await db.client.acquireConnection();
  try {
    await db.raw('SET FOREIGN_KEY_CHECKS = 0').connection(conn);
    for (const t of TABLES) await db.raw(`TRUNCATE TABLE \`${t}\``).connection(conn);
    await db.raw('SET FOREIGN_KEY_CHECKS = 1').connection(conn);
  } finally {
    await db.client.releaseConnection(conn);
  }
  clearSettingsCache();
  tokenCache.clear();
  MockAdapter.reset();
  MockPms.reset();
  outbox.emails.length = 0;
  outbox.webPush.length = 0;
  outbox.guestPush.length = 0;

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) await db('settings').insert({ key, value: JSON.stringify(value) });

  passwordHash ??= await bcrypt.hash(PASSWORD, 4);
  const staff = {};
  for (const role of ROLES) {
    const [id] = await db('staff').insert({ name: `Test ${role}`, email: `${role}@test.local`, role, password_hash: passwordHash });
    staff[role] = { id, role, email: `${role}@test.local` };
  }
  return staff;
}

const tokenCache = new Map();

/** Logs in as a role and returns the access token. */
export async function tokenFor(role, { fresh = false } = {}) {
  if (!fresh && tokenCache.has(role)) {
    const cached = tokenCache.get(role);
    const ok = await db('sessions').where({ id: cached.sid }).whereNull('revoked_at').first('id');
    if (ok) return cached.token;
  }
  const res = await api().post('/staff/login').send({ email: `${role}@test.local`, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Login as ${role} failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.data.accessToken;
  const sid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sid;
  tokenCache.set(role, { token, sid });
  return token;
}

export const clearTokenCache = () => tokenCache.clear();

export const as = async (role) => {
  const token = await tokenFor(role);
  const wrap = (method) => (url) => api()[method](url).set('Authorization', `Bearer ${token}`);
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
};

/**
 * Creates floors, rooms and mock devices. Returns { adapterId, rooms: [{id, number}] }.
 * guestDevices: also add a dimmable light, a plain light, curtains, a TV and a speaker per room.
 */
export async function seedHotel({ floors = 2, perFloor = 3, guestDevices = false } = {}) {
  const [adapterId] = await db('adapters').insert({ name: 'Mock', vendor: 'mock', config: JSON.stringify({}) });
  const [typeId] = await db('room_types').insert({ name: 'Standard' });
  const rooms = [];
  for (let f = 1; f <= floors; f++) {
    const [floorId] = await db('floors').insert({ number: f, name: `Floor ${f}` });
    for (let n = 1; n <= perFloor; n++) {
      const number = `${f}0${n}`;
      const [id] = await db('rooms').insert({ number, floor_id: floorId, room_type_id: typeId });
      rooms.push({ id, number });
      for (const type of ['lock', 'thermostat', 'sensor', 'meter']) {
        const [deviceId] = await db('devices').insert({ adapter_id: adapterId, external_id: `${type}-${number}`, room_id: id, type, name: type });
        await db('device_states').insert({ device_id: deviceId, online: true, state: JSON.stringify(type === 'thermostat' ? { mode: 'cool', setpoint: 22 } : {}) });
      }
      if (guestDevices) {
        const extra = [
          ['light', 'Bedside', { dimmable: true }],
          ['light', 'Ceiling', null],
          ['curtain', 'Curtains', null],
          ['tv', 'TV', { inputs: ['tv', 'hdmi1'] }],
          ['speaker', 'Speaker', null],
        ];
        for (const [type, name, caps] of extra) {
          const [deviceId] = await db('devices').insert({ adapter_id: adapterId, external_id: `${type}-${name}-${number}`, room_id: id, type, name, capabilities: caps ? JSON.stringify(caps) : null });
          await db('device_states').insert({ device_id: deviceId, online: true, state: JSON.stringify({}) });
        }
      }
    }
  }
  return { adapterId, rooms };
}

export async function checkIn(roomId, firstName = 'Guest') {
  const [guestId] = await db('guests').insert({ first_name: firstName, last_name: 'Test' });
  const [stayId] = await db('stays').insert({ room_id: roomId, guest_id: guestId, status: 'checked_in', check_in_at: new Date(), checked_in_at: new Date(), check_out_at: new Date(Date.now() + 86_400_000), reference: `TEST${roomId}${guestId}` });
  await db('stay_guests').insert({ stay_id: stayId, guest_id: guestId, is_primary: true });
  return { guestId, stayId };
}

/** Lets debounced listeners and fire-and-forget promises finish. */
export const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
