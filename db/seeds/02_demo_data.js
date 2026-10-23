import bcrypt from 'bcryptjs';
import { env } from '../../src/config/env.js';

/**
 * Demo hotel for development: 3 floors x 8 rooms, a mock device adapter, one staff
 * account per role, guests, requests, alerts, feedback and a week of energy readings.
 * Skipped in production and when rooms already exist.
 */
export async function seed(knex) {
  if (env.isProd || env.isTest) return;
  if ((await knex('rooms').count({ n: '*' }).first()).n > 0) return;

  const password = await bcrypt.hash('Password123!', 12);
  const roles = [
    ['Sam Service', 'service@smartstay.local', 'service'],
    ['Mia Maintenance', 'maintenance@smartstay.local', 'maintenance'],
    ['Femi Frontdesk', 'frontdesk@smartstay.local', 'front_desk'],
    ['Grace Manager', 'manager@smartstay.local', 'manager'],
  ];
  for (const [name, email, role] of roles) {
    await knex('staff').insert({ name, email, role, password_hash: password }).onConflict('email').ignore();
  }
  const serviceId = (await knex('staff').where({ email: 'service@smartstay.local' }).first('id')).id;

  const [adapterId] = await knex('adapters').insert({ name: 'Demo devices', vendor: 'mock', config: JSON.stringify({}) });
  await knex('room_types').insert([{ name: 'Standard' }, { name: 'Deluxe' }, { name: 'Suite' }]);
  const types = Object.fromEntries((await knex('room_types')).map((t) => [t.name, t.id]));

  const rooms = [];
  for (let floor = 1; floor <= 3; floor++) {
    const [floorId] = await knex('floors').insert({ number: floor, name: `Floor ${floor}` });
    for (let n = 1; n <= 8; n++) {
      const number = `${floor}${String(n).padStart(2, '0')}`;
      const type = n === 8 ? 'Suite' : n >= 6 ? 'Deluxe' : 'Standard';
      const [roomId] = await knex('rooms').insert({ number, floor_id: floorId, room_type_id: types[type] });
      rooms.push({ id: roomId, number });
      const devices = [
        ['lock', 'Door lock', null, {}],
        ['thermostat', 'AC', null, { power: true, mode: 'cool', setpoint: 22, fan: 'auto', temperature: 24 }],
        ['light', 'Ceiling', null, { on: false }],
        ['light', 'Bedside', { dimmable: true }, { on: true, brightness: 40 }],
        ['curtain', 'Curtains', null, { position: 0 }],
        ['tv', 'TV', { inputs: ['tv', 'hdmi1', 'hdmi2'] }, { power: false, volume: 20, input: 'tv', channel: 1 }],
        ['sensor', 'Presence sensor', null, {}],
        ['meter', 'Energy meter', null, {}],
      ];
      for (const [dtype, label, caps, state] of devices) {
        const [deviceId] = await knex('devices').insert({ adapter_id: adapterId, external_id: `${dtype}-${label.toLowerCase()}-${number}`, room_id: roomId, type: dtype, name: label, capabilities: caps ? JSON.stringify(caps) : null });
        await knex('device_states').insert({ device_id: deviceId, online: true, state: JSON.stringify(state), last_seen_at: new Date() });
      }
    }
  }

  const first = ['Ada', 'Tunde', 'Chika', 'Bola', 'Ngozi', 'Emeka', 'Zainab', 'Ife', 'Kemi', 'Musa', 'Lara', 'Obi'];
  const now = Date.now();
  const stays = [];
  for (let i = 0; i < 14; i++) {
    const room = rooms[(i * 5) % rooms.length];
    if (stays.some((s) => s.roomId === room.id)) continue;
    const [guestId] = await knex('guests').insert({ first_name: first[i % first.length], last_name: 'Guest', email: `guest${i}@example.com`, language: 'en' });
    const [stayId] = await knex('stays').insert({
      room_id: room.id, guest_id: guestId, status: 'checked_in', reference: `SSDEMO${String(i).padStart(2, '0')}`,
      check_in_at: new Date(now - 86_400_000), checked_in_at: new Date(now - 86_400_000), check_out_at: new Date(now + 2 * 86_400_000), adults: 1 + (i % 2),
    });
    await knex('stay_guests').insert({ stay_id: stayId, guest_id: guestId, is_primary: true });
    stays.push({ roomId: room.id, guestId, stayId });
  }
  await knex('rooms').where({ id: stays[0].roomId }).update({ dnd: true, dnd_updated_at: new Date() });

  // Two reservations arriving today, so the front desk screen has something to check in.
  const freeRooms = rooms.filter((r) => !stays.some((s) => s.roomId === r.id));
  for (const [i, [firstName, lastName]] of [['Yemi', 'Alade'], ['Tolu', 'Okafor']].entries()) {
    const [guestId] = await knex('guests').insert({ first_name: firstName, last_name: lastName, email: `${firstName.toLowerCase()}@example.com`, language: 'en' });
    const [stayId] = await knex('stays').insert({
      room_id: freeRooms[i].id, guest_id: guestId, status: 'reserved', reference: `SSARRV0${i + 1}`,
      check_in_at: new Date(now + (i + 1) * 3_600_000), check_out_at: new Date(now + 3 * 86_400_000), adults: 2,
    });
    await knex('stay_guests').insert({ stay_id: stayId, guest_id: guestId, is_primary: true });
  }

  const reqs = [
    [stays[1], 'housekeeping', 'Extra towels please', 'new', null],
    [stays[2], 'amenities', 'Two bottles of water', 'assigned', serviceId],
    [stays[3], 'maintenance', 'TV remote not working', 'in_progress', serviceId],
  ];
  for (const [s, category, description, status, assigned] of reqs) {
    const [id] = await knex('requests').insert({ room_id: s.roomId, stay_id: s.stayId, guest_id: s.guestId, category, description, status, source: 'guest', assigned_to: assigned });
    await knex('request_events').insert({ request_id: id, actor_type: 'guest', action: 'created', to_status: 'new' });
  }

  const lockDevice = await knex('devices').where({ room_id: rooms[10].id, type: 'lock' }).first();
  await knex('device_states').where({ device_id: lockDevice.id }).update({ online: false });
  await knex('alerts').insert({
    room_id: rooms[10].id, device_id: lockDevice.id, type: 'device_offline', severity: 'critical', source: 'device',
    title: 'Door lock is offline', dedupe_key: `device_offline:${rooms[10].id}:${lockDevice.id}:-:-`, occurrence_count: 3,
  });

  const comments = ['Lovely stay', 'Room was a bit noisy', 'AC too cold at night', 'Great service', 'Bathroom not clean'];
  for (let i = 0; i < 20; i++) {
    const s = stays[i % stays.length];
    await knex('feedback').insert({ room_id: s.roomId, stay_id: s.stayId, guest_id: s.guestId, rating: (i % 5) + 1, comment: comments[i % comments.length], created_at: new Date(now - i * 8 * 3_600_000) });
  }

  const meters = await knex('devices').where({ type: 'meter' });
  const readings = [];
  for (const m of meters) {
    for (let h = 7 * 24; h > 0; h--) {
      const t = new Date(now - h * 3_600_000);
      t.setUTCMinutes(0, 0, 0);
      const hour = t.getUTCHours();
      readings.push({ room_id: m.room_id, device_id: m.id, period_start: t, kwh: (0.2 + ((m.id * 3 + hour * 7) % 10) / 12).toFixed(4), source: 'seed' });
    }
  }
  for (let i = 0; i < readings.length; i += 1000) await knex('energy_readings').insert(readings.slice(i, i + 1000));

  await knex('rules').insert({
    name: 'Eco mode in empty rooms', type: 'vacancy', is_enabled: true,
    target: JSON.stringify({ scope: 'all' }), conditions: JSON.stringify({ trigger: 'unsold' }), actions: JSON.stringify([{ type: 'set_climate', mode: 'eco' }]),
  });

  console.log('Demo data created. Staff logins use password Password123! (service@, maintenance@, frontdesk@, manager@smartstay.local)');
}
