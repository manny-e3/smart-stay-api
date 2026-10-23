import { env } from '../../config/env.js';
import QRCode from 'qrcode';
import { db, paginate, json } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { accessCode, bookingReference, lookupHash, qrToken, normaliseCode } from '../../core/crypto.js';
import { applyGuestPreferences } from '../guest/preferences.service.js';
import { AppError, badRequest, conflict, notFound } from '../../core/errors.js';
import { bus, EVENTS } from '../../core/events.js';
import { sendEmail } from '../../core/notifier.js';
import { dayRange, todayRange } from '../../core/time.js';
import { getSettings } from '../settings/settings.service.js';
import { issueKeysForStay, revokeKeysForStay, extendKeysForStay, toKey } from '../keys/keys.service.js';
import { getRequest } from '../requests/requests.service.js';

/**
 * Stay lifecycle. Every change to a booking goes through this file, whether it comes from
 * the front desk, the PMS sync or a background job, so side effects are always the same:
 * history row, audit entry, live board update, digital keys and guest app access.
 *
 * actor: { type: 'staff', id, ip } | { type: 'pms', connectionId } | { type: 'system' }
 */

export const STAY_STATUSES = ['reserved', 'checked_in', 'checked_out', 'cancelled', 'no_show'];
const ACTIVE = ['reserved', 'checked_in'];
const OPEN_REQUESTS = ['new', 'assigned', 'in_progress'];
// Maintenance requests belong to the room, everything else follows the guest.
const ROOM_BOUND_CATEGORIES = ['maintenance'];

/* ------------------------------------------------------------- helpers */

const auditActor = (actor) => (actor.type === 'staff' ? { type: 'staff', id: actor.id } : actor.type === 'guest' ? { type: 'guest', id: actor.id } : { type: 'system' });

async function record(trx, stayId, actor, action, { roomId = null, fromRoomId = null, toRoomId = null, note = null, data = null } = {}) {
  const settings = await getSettings();
  const override = actor.type === 'staff' && settings.booking_mode === 'pms';
  const payload = override ? { ...(data || {}), manualOverride: true } : data;
  await trx('stay_events').insert({
    stay_id: stayId,
    actor_type: actor.type === 'staff' ? 'staff' : actor.type,
    staff_id: actor.type === 'staff' ? actor.id : null,
    action,
    from_room_id: fromRoomId,
    to_room_id: toRoomId,
    note,
    data: json(payload),
  });
  await audit(
    {
      actor: auditActor(actor),
      action: `stay.${action}`,
      entityType: 'stay',
      entityId: stayId,
      roomId: toRoomId ?? roomId ?? fromRoomId,
      details: { ...(payload || {}), ...(note ? { note } : {}), ...(actor.type === 'pms' ? { source: 'pms', connectionId: actor.connectionId } : {}) },
      ip: actor.ip ?? null,
    },
    trx,
  );
}

const STAY_COLUMNS = [
  's.*',
  'g.first_name', 'g.last_name', 'g.email as guest_email', 'g.phone as guest_phone', 'g.language as guest_language', 'g.vip as guest_vip',
  'r.number as room_number', 'f.number as floor_number', 't.name as room_type_name',
];

const stayQuery = (trx = db) =>
  trx('stays as s')
    .join('guests as g', 'g.id', 's.guest_id')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .leftJoin('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('room_types as t', 't.id', 's.room_type_id');

export const toStay = (s) => ({
  id: s.id,
  reference: s.reference,
  status: s.status,
  source: s.source,
  externalId: s.external_id,
  room: s.room_id ? { id: s.room_id, number: s.room_number, floor: s.floor_number } : null,
  roomType: s.room_type_name ?? null,
  guest: {
    id: s.guest_id,
    firstName: s.first_name,
    lastName: s.last_name,
    email: s.guest_email,
    phone: s.guest_phone,
    language: s.guest_language,
    vip: Boolean(s.guest_vip),
  },
  arrival: s.check_in_at,
  departure: s.check_out_at,
  checkedInAt: s.checked_in_at,
  checkedOutAt: s.checked_out_at,
  adults: s.adults,
  children: s.children,
  notes: s.notes,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

async function loadStay(id, trx = db) {
  const s = await stayQuery(trx).where('s.id', id).first(STAY_COLUMNS);
  return s ? toStay(s) : null;
}

async function lockStay(trx, id) {
  const stay = await trx('stays').where({ id }).forUpdate().first();
  if (!stay) throw notFound('Stay');
  return stay;
}

function assertStatus(stay, allowed, action) {
  if (!allowed.includes(stay.status)) throw badRequest(`Cannot ${action} a stay that is ${stay.status.replace('_', ' ')}`);
}

async function resolveRoom(trx, roomId, { lock = false } = {}) {
  const q = trx('rooms').where({ id: roomId });
  if (lock) q.forUpdate();
  const room = await q.first();
  if (!room || !room.is_active) throw badRequest('Room not found or inactive');
  return room;
}

async function resolveRoomType(trx, name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  let type = await trx('room_types').where({ name: trimmed }).first('id');
  if (type) return type.id;

  type = await trx('room_types').whereRaw('LOWER(name) = ?', [trimmed.toLowerCase()]).first('id');
  if (type) return type.id;

  // Handle common compound strings like "Deluxe Suite" -> matches "Suite" or "Deluxe"
  const allTypes = await trx('room_types').select('id', 'name');
  const matched = allTypes.find((t) => trimmed.toLowerCase().includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(trimmed.toLowerCase()));
  if (matched) return matched.id;

  throw badRequest(`Unknown room type "${name}"`);
}

/**
 * Another active stay that overlaps [from, to) in the room. A checked-in guest past their
 * departure still occupies the room, so they block any range starting before now.
 */
export async function findOverlap(trx, roomId, from, to, excludeStayId = 0) {
  const now = new Date();
  return trx('stays')
    .where({ room_id: roomId })
    .whereIn('status', ACTIVE)
    .whereNot('id', excludeStayId)
    .where('check_in_at', '<', to)
    .where((w) => {
      w.where('check_out_at', '>', from);
      if (from < now) w.orWhere('status', 'checked_in');
    })
    .first('id', 'reference', 'status', 'check_in_at', 'check_out_at');
}

async function assertNoOverlap(trx, roomId, from, to, excludeStayId) {
  const clash = await findOverlap(trx, roomId, from, to, excludeStayId);
  if (clash) {
    const room = await trx('rooms').where({ id: roomId }).first('number');
    throw conflict(`Room ${room?.number ?? roomId} is booked for those dates (${clash.reference}, ${clash.status.replace('_', ' ')})`);
  }
}

function assertDates(arrival, departure) {
  if (!(departure > arrival)) throw badRequest('Departure must be after arrival');
}

async function uniqueReference(trx) {
  for (let i = 0; i < 10; i++) {
    const ref = bookingReference();
    if (!(await trx('stays').where({ reference: ref }).first('id'))) return ref;
  }
  throw new Error('Could not generate a unique booking reference');
}

/** Finds or creates a guest from { id } or profile fields. */
export async function upsertGuest(trx, input, { pmsConnectionId = null } = {}) {
  if (input.id) {
    const g = await trx('guests').where({ id: input.id }).first();
    if (!g || g.anonymized_at) throw badRequest('Guest not found');
    return g.id;
  }
  const fields = {
    first_name: input.firstName,
    last_name: input.lastName ?? null,
    email: input.email?.toLowerCase() ?? null,
    phone: input.phone ?? null,
    language: input.language ?? null,
    ...(input.vip !== undefined ? { vip: input.vip } : {}),
  };
  if (pmsConnectionId && input.externalId) {
    const existing = await trx('guests').where({ pms_connection_id: pmsConnectionId, external_id: input.externalId }).first('id');
    if (existing) {
      await trx('guests').where({ id: existing.id }).update(fields);
      return existing.id;
    }
    const [id] = await trx('guests').insert({ ...fields, pms_connection_id: pmsConnectionId, external_id: input.externalId });
    return id;
  }
  const [id] = await trx('guests').insert(fields);
  return id;
}

const publish = (stayId, action, roomIds = []) => {
  bus.publish(EVENTS.STAY_CHANGED, { stayId, action });
  for (const roomId of new Set(roomIds.filter(Boolean))) bus.publish(EVENTS.ROOM_CHANGED, { roomId });
};

/**
 * Creates a new booking code and QR token for a stay and revokes the old ones.
 * Both are stored only as keyed hashes; the plain values are returned once.
 */
async function issueGuestAccess(trx, stayId, createdBy) {
  await trx('guest_access_codes').where({ stay_id: stayId }).whereNull('revoked_at').update({ revoked_at: new Date() });
  const insertUnique = async (kind, make) => {
    for (let i = 0; i < 10; i++) {
      const value = make();
      try {
        await trx('guest_access_codes').insert({ stay_id: stayId, kind, lookup_hash: lookupHash(value), created_by: createdBy });
        return value;
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
      }
    }
    throw new Error('Could not generate a unique guest access code');
  };
  return { accessCode: await insertUnique('code', accessCode), qrToken: await insertUnique('qr', qrToken) };
}

const qrUrlFor = (base, token) => `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

function translateDuplicate(err, roomNumber) {
  if (err.code === 'ER_DUP_ENTRY' && /active_room/.test(err.message)) return conflict(`Room ${roomNumber} already has a checked-in guest`);
  return err;
}

/* --------------------------------------------------------------- reads */

export async function getStay(id) {
  const stay = await loadStay(id);
  if (!stay) throw notFound('Stay');
  const [guests, events, requests, keys, feedback] = await Promise.all([
    db('stay_guests as sg').join('guests as g', 'g.id', 'sg.guest_id').where('sg.stay_id', id).orderBy('sg.is_primary', 'desc').select('g.id', 'g.first_name', 'g.last_name', 'g.email', 'g.phone', 'sg.is_primary'),
    db('stay_events as e').leftJoin('staff as st', 'st.id', 'e.staff_id').leftJoin('rooms as fr', 'fr.id', 'e.from_room_id').leftJoin('rooms as tr', 'tr.id', 'e.to_room_id').where('e.stay_id', id).orderBy('e.id').select('e.*', 'st.name as staff_name', 'fr.number as from_room', 'tr.number as to_room'),
    db('requests').where({ stay_id: id }).orderBy('created_at', 'desc').select('id', 'category', 'status', 'room_id', 'created_at'),
    db('digital_keys').where({ stay_id: id }).orderBy('id'),
    db('feedback').where({ stay_id: id }).select('id', 'rating', 'comment', 'created_at'),
  ]);
  return {
    ...stay,
    guests: guests.map((g) => ({ id: g.id, firstName: g.first_name, lastName: g.last_name, email: g.email, phone: g.phone, isPrimary: Boolean(g.is_primary) })),
    history: events.map((e) => ({
      id: e.id,
      action: e.action,
      actor: e.actor_type === 'staff' ? { type: 'staff', id: e.staff_id, name: e.staff_name } : { type: e.actor_type },
      fromRoom: e.from_room,
      toRoom: e.to_room,
      note: e.note,
      data: e.data,
      at: e.created_at,
    })),
    requests: requests.map((r) => ({ id: r.id, category: r.category, status: r.status, roomId: r.room_id, createdAt: r.created_at })),
    keys: keys.map(toKey),
    feedback: feedback.map((f) => ({ id: f.id, rating: f.rating, comment: f.comment, createdAt: f.created_at })),
  };
}

export async function listStays({ status, arrivalDate, departureDate, inHouse, roomId, q, page, limit }) {
  const { timezone } = await getSettings();
  const query = stayQuery().select(STAY_COLUMNS).orderBy('s.check_in_at', 'desc');
  if (status?.length) query.whereIn('s.status', status);
  if (inHouse) query.where('s.status', 'checked_in');
  if (roomId) query.where('s.room_id', roomId);
  if (arrivalDate) {
    const { start, end } = dayRange(arrivalDate, timezone);
    query.where('s.check_in_at', '>=', start).where('s.check_in_at', '<', end);
  }
  if (departureDate) {
    const { start, end } = dayRange(departureDate, timezone);
    query.where('s.check_out_at', '>=', start).where('s.check_out_at', '<', end);
  }
  if (q) {
    query.where((w) =>
      w
        .whereILike('s.reference', `%${q}%`)
        .orWhereILike('g.first_name', `%${q}%`)
        .orWhereILike('g.last_name', `%${q}%`)
        .orWhereILike('g.email', `%${q}%`)
        .orWhereILike('g.phone', `%${q}%`)
        .orWhere('r.number', q),
    );
  }
  const result = await paginate(query, { page, limit });
  return { ...result, items: result.items.map(toStay) };
}

/** The front desk's day: arrivals, departures, in-house guests, overdue check-outs and free rooms. */
export async function frontDeskToday(now = new Date()) {
  const settings = await getSettings();
  const { start, end } = todayRange(settings.timezone, now);
  const graceCutoff = new Date(now.getTime() - settings.checkout_grace_minutes * 60_000);

  const [arrivals, departures, overdue, inHouse, rooms] = await Promise.all([
    stayQuery().where('s.status', 'reserved').where('s.check_in_at', '<', end).where('s.check_out_at', '>', now).orderBy('s.check_in_at').select(STAY_COLUMNS),
    stayQuery().where('s.status', 'checked_in').where('s.check_out_at', '>=', start).where('s.check_out_at', '<', end).orderBy('s.check_out_at').select(STAY_COLUMNS),
    stayQuery().where('s.status', 'checked_in').where('s.check_out_at', '<', graceCutoff).orderBy('s.check_out_at').select(STAY_COLUMNS),
    db('stays').where({ status: 'checked_in' }).count({ n: '*' }).first(),
    db('rooms').where({ is_active: true }).count({ n: '*' }).first(),
  ]);
  const occupied = Number(inHouse.n);
  return {
    date: start,
    timezone: settings.timezone,
    counts: {
      arrivals: arrivals.length,
      departures: departures.length,
      overdueCheckOuts: overdue.length,
      inHouse: occupied,
      vacantRooms: Number(rooms.n) - occupied,
      totalRooms: Number(rooms.n),
    },
    arrivals: arrivals.map((s) => ({ ...toStay(s), late: new Date(s.check_in_at) < start })),
    departures: departures.map(toStay),
    overdueCheckOuts: overdue.map(toStay),
  };
}

/** Rooms free for the whole of [from, to). */
export async function availability({ from, to, roomType }) {
  assertDates(from, to);
  const q = db('rooms as r')
    .join('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('room_types as t', 't.id', 'r.room_type_id')
    .where('r.is_active', true)
    .select('r.id', 'r.number', 'f.number as floor', 't.name as room_type')
    .orderBy(['f.number', 'r.number']);
  if (roomType) q.where('t.name', roomType);
  const rooms = await q;
  const free = [];
  for (const r of rooms) if (!(await findOverlap(db, r.id, from, to))) free.push({ id: r.id, number: r.number, floor: r.floor, roomType: r.room_type });
  const byType = {};
  for (const r of free) byType[r.roomType ?? 'Unassigned'] = (byType[r.roomType ?? 'Unassigned'] || 0) + 1;
  return { from, to, total: free.length, byRoomType: byType, rooms: free };
}

/* ------------------------------------------------------------- writes */

/**
 * Creates a reservation (or a walk-in with checkInNow). Staff can't create bookings while the
 * hotel runs in PMS mode, because the PMS owns reservations then.
 */
export async function createStay(input, actor) {
  if (actor.type === 'staff') {
    const { booking_mode: mode } = await getSettings();
    if (mode === 'pms') throw conflict('Bookings come from the PMS. Create the reservation there; it will appear here automatically.');
  }
  const arrival = input.checkInNow ? new Date() : new Date(input.arrival);
  const departure = new Date(input.departure);
  assertDates(arrival, departure);
  if (input.checkInNow && !input.roomId) throw badRequest('Choose a room to check the guest in now');

  const id = await db.transaction(async (trx) => {
    const guestId = await upsertGuest(trx, input.guest, { pmsConnectionId: actor.type === 'pms' ? actor.connectionId : null });
    let room = null;
    if (input.roomId) {
      room = await resolveRoom(trx, input.roomId, { lock: true });
      await assertNoOverlap(trx, room.id, arrival, departure);
    }
    let roomTypeId = null;
    if (input.roomType) {
      try {
        roomTypeId = await resolveRoomType(trx, input.roomType);
      } catch (err) {
        if (room?.room_type_id) {
          roomTypeId = room.room_type_id;
        } else {
          throw err;
        }
      }
    } else {
      roomTypeId = room?.room_type_id ?? null;
    }
    const [stayId] = await trx('stays').insert({
      reference: input.reference || (await uniqueReference(trx)),
      source: actor.type === 'pms' ? 'pms' : 'manual',
      pms_connection_id: actor.type === 'pms' ? actor.connectionId : null,
      external_id: input.externalId ?? null,
      room_id: room?.id ?? null,
      room_type_id: roomTypeId,
      guest_id: guestId,
      status: 'reserved',
      check_in_at: arrival,
      check_out_at: departure,
      adults: input.adults ?? 1,
      children: input.children ?? 0,
      notes: input.notes ?? null,
      created_by: actor.type === 'staff' ? actor.id : null,
    });
    await trx('stay_guests').insert({ stay_id: stayId, guest_id: guestId, is_primary: true });
    for (const companion of input.companions || []) {
      const cid = await upsertGuest(trx, companion, { pmsConnectionId: actor.type === 'pms' ? actor.connectionId : null });
      if (cid !== guestId) await trx('stay_guests').insert({ stay_id: stayId, guest_id: cid, is_primary: false }).onConflict(['stay_id', 'guest_id']).ignore();
    }
    await record(trx, stayId, actor, 'created', { toRoomId: room?.id, data: { arrival, departure, walkIn: Boolean(input.checkInNow) } });
    return stayId;
  });

  publish(id, 'created', [input.roomId]);
  if (input.checkInNow) return checkIn(id, { roomId: input.roomId }, actor);

  // Issue access codes for new reservation so guest can log into mobile app
  const access = await db.transaction(async (trx) => {
    return issueGuestAccess(trx, id, actor.type === 'staff' ? actor.id : null);
  });
  const settings = await getSettings();
  const qrUrl = qrUrlFor(settings.guest_app_login_url, access.qrToken);
  const stay = await getStay(id);

  // Send reservation confirmation email with full login credentials
  if (!env.isTest) await emailGuestReservation(stay, access.accessCode, qrUrl, settings, false);

  return { stay, accessCode: access.accessCode, qrToken: access.qrToken, qrUrl };
}

/** Edits a booking. Dates and room of a checked-in stay change through extend and move instead. */
export async function updateStay(id, patch, actor) {
  let extended = false;
  const roomIds = [];
  await db.transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ACTIVE, 'edit');
    const changes = {};
    const update = {};

    if (stay.status === 'checked_in' && (patch.arrival !== undefined || patch.roomId !== undefined)) {
      throw badRequest('The guest is checked in: use extend to change the departure and move to change the room');
    }
    const arrival = patch.arrival ? new Date(patch.arrival) : new Date(stay.check_in_at);
    const departure = patch.departure ? new Date(patch.departure) : new Date(stay.check_out_at);
    if (patch.arrival || patch.departure) {
      assertDates(arrival, departure);
      if (departure <= new Date()) throw badRequest('Departure must be in the future');
      update.check_in_at = arrival;
      update.check_out_at = departure;
      changes.arrival = arrival;
      changes.departure = departure;
      extended = stay.status === 'checked_in';
    }
    let roomId = stay.room_id;
    if (patch.roomId !== undefined) {
      roomId = patch.roomId;
      if (roomId) await resolveRoom(trx, roomId, { lock: true });
      update.room_id = roomId;
      changes.roomId = roomId;
      roomIds.push(stay.room_id, roomId);
    }
    if (roomId && (patch.arrival || patch.departure || patch.roomId)) await assertNoOverlap(trx, roomId, arrival, departure, id);
    if (patch.roomType !== undefined) update.room_type_id = await resolveRoomType(trx, patch.roomType);
    for (const [k, col] of [['adults', 'adults'], ['children', 'children'], ['notes', 'notes']]) {
      if (patch[k] !== undefined) {
        update[col] = patch[k];
        changes[k] = patch[k];
      }
    }
    for (const companion of patch.addGuests || []) {
      const cid = await upsertGuest(trx, companion);
      await trx('stay_guests').insert({ stay_id: id, guest_id: cid, is_primary: false }).onConflict(['stay_id', 'guest_id']).ignore();
      changes.addedGuests = (changes.addedGuests || 0) + 1;
    }
    if (!Object.keys(update).length && !changes.addedGuests) return;
    if (Object.keys(update).length) await trx('stays').where({ id }).update(update);
    await record(trx, id, actor, 'updated', { roomId, data: changes });
  });
  if (extended) await extendKeysForStay(id);
  publish(id, 'updated', roomIds);
  return getStay(id);
}

/** Checks a guest in: room locked and empty, guest app code created, digital keys issued. */
export async function checkIn(id, { roomId } = {}, actor) {
  const now = new Date();
  let access;
  let room;
  const settings = await getSettings();
  try {
    await db.transaction(async (trx) => {
      const stay = await lockStay(trx, id);
      assertStatus(stay, ['reserved'], 'check in');
      const targetRoomId = roomId ?? stay.room_id;
      if (!targetRoomId) throw badRequest('Choose a room before checking the guest in');
      room = await resolveRoom(trx, targetRoomId, { lock: true });
      if (new Date(stay.check_out_at) <= now) throw badRequest('The departure date has passed. Change the dates before checking in.');

      const occupant = await trx('stays').where({ room_id: room.id, status: 'checked_in' }).first('id', 'reference');
      if (occupant) throw conflict(`Room ${room.number} already has a checked-in guest (${occupant.reference})`);
      await assertNoOverlap(trx, room.id, now, new Date(stay.check_out_at), id);

      await trx('stays').where({ id }).update({
        status: 'checked_in',
        room_id: room.id,
        room_type_id: stay.room_type_id ?? room.room_type_id,
        checked_in_at: now,
        access_failures: 0,
        access_locked_until: null,
      });
      await trx('rooms').where({ id: room.id }).update({ dnd: false, dnd_updated_at: now, cleaning_requested: false, cleaning_requested_at: null, cleaning_request_id: null });

      access = await issueGuestAccess(trx, id, actor.type === 'staff' ? actor.id : null);
      await record(trx, id, actor, 'checked_in', { toRoomId: room.id, fromRoomId: stay.room_id && stay.room_id !== room.id ? stay.room_id : null });
    });
  } catch (err) {
    throw translateDuplicate(err, room?.number);
  }

  const keys = await issueKeysForStay(id);
  const stay = await getStay(id);
  const warnings = [];
  const critical = await db('alerts').where({ room_id: stay.room.id, status: 'open', severity: 'critical' }).select('title');
  for (const a of critical) warnings.push(`Open critical alert in this room: ${a.title}`);
  if (!keys.length) warnings.push('This room has no digital lock; give the guest a key card');
  if (keys.some((k) => k.status === 'failed')) warnings.push('A digital key could not be issued; give the guest a key card and retry the keys');

  let preferences = null;
  if (settings.apply_guest_preferences_on_check_in) {
    preferences = await applyGuestPreferences(id, { type: 'system' });
    if (preferences?.failed) warnings.push('Some of the guest’s saved preferences could not be applied to the room');
  }

  const qrUrl = qrUrlFor(settings.guest_app_login_url, access.qrToken);
  await emailGuestAccess(stay, access.accessCode, qrUrl, settings);
  publish(id, 'checked_in', [stay.room.id]);
  return { stay, accessCode: access.accessCode, qrToken: access.qrToken, qrUrl, keys, warnings, preferences };
}

async function emailGuestAccess(stay, code, qrUrl, settings) {
  return emailGuestReservation(stay, code, qrUrl, settings, true);
}

export async function emailGuestReservation(stay, code, qrUrl, settings, isCheckIn = false) {
  if (!stay?.guest?.email) return;
  const hotelName = settings?.hotel_name || 'SmartStay Hotel';
  const roomNumber = stay.room?.number ? `Room ${stay.room.number}` : 'Allocated at Check-in';
  const arrivalDate = stay.arrival || stay.check_in_at;
  const departureDate = stay.departure || stay.check_out_at;
  const arrivalStr = arrivalDate ? new Date(arrivalDate).toLocaleDateString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }) : 'Scheduled';
  const departureStr = departureDate ? new Date(departureDate).toLocaleDateString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }) : 'Scheduled';
  
  const appBase = settings?.guest_app_login_url || 'http://localhost:5173';
  const appUrl = qrUrl || `${appBase}?ref=${encodeURIComponent(stay.reference || '')}&lastName=${encodeURIComponent(stay.guest?.lastName || '')}&code=${encodeURIComponent(code || '')}`;

  const subject = isCheckIn
    ? `Welcome to ${hotelName} - ${roomNumber} [Access Code: ${code || stay.reference}]`
    : `Reservation Confirmed: ${stay.reference} - ${hotelName}`;

  const textLines = [
    `Dear ${stay.guest.firstName} ${stay.guest.lastName},`,
    '',
    isCheckIn
      ? `Welcome to ${hotelName}! You are checked in to ${roomNumber}.`
      : `Thank you for choosing ${hotelName}. Your reservation has been successfully confirmed.`,
    '',
    '=== YOUR STAY DETAILS ===',
    `Booking Reference: ${stay.reference}`,
    `Assigned Suite:    ${roomNumber}`,
    `Check-in Date:     ${arrivalStr} (from 2:00 PM)`,
    `Check-out Date:    ${departureStr} (until 11:00 AM)`,
    `Guests:            ${stay.adults || 1} Adult(s)${stay.children ? ', ' + stay.children + ' Children' : ''}`,
    stay.notes ? `Special Requests:  ${stay.notes}` : '',
    '',
    '=== SMARTSTAY GUEST APP LOGIN DETAILS ===',
    'Open the SmartStay mobile app or web portal on your phone to access keyless door entry, climate control, and digital concierge services.',
    '',
    'Sign In Method 1 (Booking Reference & Last Name):',
    `  Booking Reference: ${stay.reference}`,
    `  Last Name:         ${stay.guest.lastName}`,
    '',
    code ? `Sign In Method 2 (Direct Digital Access Code):\n  Access Code:       ${code}\n` : '',
    `Direct Mobile Access Link: ${appUrl}`,
    '',
    'We look forward to providing you with an exceptional stay.',
    '',
    'Warm regards,',
    `Front Desk & Guest Services | ${hotelName}`
  ].filter(Boolean);

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F7F7F5; margin: 0; padding: 24px; color: #1A1C1B; }
        .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #E5E7EB; overflow: hidden; box-shadow: 0 4px 16px rgba(11,31,58,0.06); }
        .header { background: #0B1F3A; padding: 32px 28px; text-align: center; color: #ffffff; }
        .logo-pill { display: inline-block; padding: 4px 12px; background: rgba(201,162,39,0.2); border: 1px solid #C9A227; border-radius: 20px; color: #ECC246; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 12px; }
        .title { margin: 0; font-size: 22px; font-weight: 700; color: #ffffff; }
        .content { padding: 32px 28px; line-height: 1.6; font-size: 14px; }
        .credentials-box { background: #F9F9F7; border: 2px dashed #C9A227; border-radius: 12px; padding: 20px; margin: 24px 0; }
        .cred-item { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 14px; }
        .cred-label { color: #64748B; font-weight: 600; }
        .cred-value { font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 16px; font-weight: 800; color: #0B1F3A; background: #ffffff; padding: 2px 8px; border-radius: 6px; border: 1px solid #E5E7EB; }
        .table-info { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .table-info td { padding: 10px 0; border-bottom: 1px solid #F1F5F9; font-size: 13px; }
        .table-info td:first-child { color: #64748B; width: 40%; font-weight: 600; }
        .table-info td:last-child { color: #0B1F3A; font-weight: 600; }
        .btn-cta { display: inline-block; padding: 12px 28px; background: #0B1F3A; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 13px; margin: 16px 0; }
        .footer { padding: 20px 28px; background: #F9F9F7; border-top: 1px solid #E5E7EB; text-align: center; font-size: 12px; color: #64748B; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <div class="logo-pill">${hotelName}</div>
          <h1 class="title">${isCheckIn ? 'Welcome to Your Suite' : 'Reservation Confirmed'}</h1>
          <p style="margin: 6px 0 0; color: #B5C7EA; font-size: 13px;">Booking Reference: <strong>${stay.reference}</strong></p>
        </div>
        <div class="content">
          <p>Dear <strong>${stay.guest.firstName} ${stay.guest.lastName}</strong>,</p>
          <p>${isCheckIn ? `Welcome to <strong>${hotelName}</strong>! You are checked in to <strong>${roomNumber}</strong>.` : `We are delighted to confirm your upcoming reservation at <strong>${hotelName}</strong>. Your suite is being prepared for your arrival.`}</p>
          
          <div class="credentials-box">
            <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #B45309; letter-spacing: 0.05em; margin-bottom: 12px;">
              🔑 SmartStay Guest Mobile App Login Details
            </div>
            <div class="cred-item">
              <span class="cred-label">Booking Reference:</span>
              <span class="cred-value">${stay.reference}</span>
            </div>
            <div class="cred-item">
              <span class="cred-label">Last Name:</span>
              <span class="cred-value">${stay.guest.lastName}</span>
            </div>
            ${code ? `
            <div class="cred-item">
              <span class="cred-label">Digital Access Code:</span>
              <span class="cred-value" style="color: #B45309; border-color: #C9A227;">${code}</span>
            </div>` : ''}
            <div style="text-align: center; margin-top: 16px;">
              <a href="${appUrl}" class="btn-cta">Open Guest Mobile Portal</a>
            </div>
          </div>

          <h3 style="font-size: 15px; color: #0B1F3A; margin-top: 24px; margin-bottom: 8px;">Itinerary & Reservation Summary</h3>
          <table class="table-info">
            <tr>
              <td>Allocated Suite</td>
              <td><strong>${roomNumber}</strong></td>
            </tr>
            <tr>
              <td>Check-in Date</td>
              <td>${arrivalStr} (from 2:00 PM)</td>
            </tr>
            <tr>
              <td>Check-out Date</td>
              <td>${departureStr} (until 11:00 AM)</td>
            </tr>
            <tr>
              <td>Guests</td>
              <td>${stay.adults || 1} Adult(s)${stay.children ? ', ' + stay.children + ' Children' : ''}</td>
            </tr>
            ${stay.notes ? `<tr><td>Special Requests</td><td>${stay.notes}</td></tr>` : ''}
          </table>

          <p style="font-size: 12px; color: #64748B; margin-top: 20px;">
            With the SmartStay app on your mobile device, you can unlock your door digitally, adjust climate & lighting, and message the concierge team 24/7.
          </p>
        </div>
        <div class="footer">
          <p style="margin: 0;">We look forward to welcoming you to ${hotelName}.</p>
          <p style="margin: 4px 0 0; font-size: 11px; color: #94A3B8;">For any inquiries or assistance, please contact the front desk.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await sendEmail({
      to: stay.guest.email,
      subject,
      text: textLines.join('\n'),
      html,
    });
    console.log(`[Reservation Email] Sent login details to ${stay.guest.email} for booking ${stay.reference}`);
  } catch (err) {
    console.error('[Reservation Email] Failed to send email:', err.message);
  }
}

/** Closes open guest requests when the guest leaves; maintenance requests stay with the room. */
async function closeGuestRequests(trx, stayId, reason) {
  const open = await trx('requests').where({ stay_id: stayId }).whereIn('status', OPEN_REQUESTS).whereNotIn('category', ROOM_BOUND_CATEGORIES).select('id', 'status');
  for (const r of open) {
    await trx('requests').where({ id: r.id }).update({ status: 'cancelled' });
    await trx('request_events').insert({ request_id: r.id, actor_type: 'system', action: 'status_changed', from_status: r.status, to_status: 'cancelled', note: reason });
  }
  return open.map((r) => r.id);
}

/** Checks a guest out: guest app access ends, keys are revoked, guest requests closed. */
export async function checkOut(id, actor, { note } = {}) {
  const now = new Date();
  const settings = await getSettings();
  let roomId;
  let closed = [];
  await db.transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ['checked_in'], 'check out');
    roomId = stay.room_id;
    await trx('stays').where({ id }).update({ status: 'checked_out', checked_out_at: now });
    await trx('guest_access_codes').where({ stay_id: id }).whereNull('revoked_at').update({ revoked_at: now });
    // For registered guest accounts with password, keep session alive and point to next stay or null
    const pwdSessions = await trx('guest_sessions').where({ stay_id: id, method: 'password' }).whereNull('revoked_at');
    for (const ps of pwdSessions) {
      const nextStay = await trx('stays')
        .where({ guest_id: ps.guest_id })
        .whereIn('status', ['checked_in', 'reserved'])
        .whereNot('id', id)
        .orderBy('check_in_at', 'desc')
        .first();
      await trx('guest_sessions').where({ id: ps.id }).update({ stay_id: nextStay?.id || null });
    }
    // Revoke anonymous/temporary access sessions
    await trx('guest_sessions').where({ stay_id: id }).whereNot('method', 'password').whereNull('revoked_at').update({ revoked_at: now });
    await trx('guest_devices').where({ stay_id: id }).del();
    await trx('rooms').where({ id: roomId }).update({ dnd: false, dnd_updated_at: now, cleaning_requested: false, cleaning_requested_at: null, cleaning_request_id: null });
    if (settings.close_requests_on_checkout) closed = await closeGuestRequests(trx, id, 'Guest checked out');
    await record(trx, id, actor, 'checked_out', { fromRoomId: roomId, note: note ?? null, data: closed.length ? { requestsClosed: closed } : null });
  });

  const keys = await revokeKeysForStay(id);
  for (const rid of closed) bus.publish(EVENTS.REQUEST_UPDATED, await getRequest(rid));
  publish(id, 'checked_out', [roomId]);
  return { stay: await getStay(id), keysRevoked: keys.filter((k) => k.ok).length, keysFailed: keys.filter((k) => !k.ok).length, requestsClosed: closed.length };
}

/** Moves a checked-in guest to another room. Guest requests and keys move with them. */
export async function moveRoom(id, { roomId, reason }, actor) {
  let fromRoomId;
  let toRoom;
  let moved = [];
  try {
    await db.transaction(async (trx) => {
      const stay = await lockStay(trx, id);
      assertStatus(stay, ['checked_in'], 'move');
      if (stay.room_id === roomId) throw badRequest('The guest is already in this room');
      fromRoomId = stay.room_id;
      // Lock both rooms in id order so two simultaneous moves can't deadlock.
      const locked = await trx('rooms').whereIn('id', [fromRoomId, roomId]).orderBy('id').forUpdate();
      toRoom = locked.find((r) => r.id === roomId);
      if (!toRoom || !toRoom.is_active) throw badRequest('Room not found or inactive');
      const occupant = await trx('stays').where({ room_id: roomId, status: 'checked_in' }).first('reference');
      if (occupant) throw conflict(`Room ${toRoom.number} already has a checked-in guest (${occupant.reference})`);
      await assertNoOverlap(trx, roomId, new Date(), new Date(stay.check_out_at), id);

      await trx('stays').where({ id }).update({ room_id: roomId, room_type_id: toRoom.room_type_id ?? stay.room_type_id });
      // A pending cleaning request follows the guest, like their other requests.
      const fromRoom = locked.find((r) => r.id === fromRoomId);
      if (fromRoom?.cleaning_requested) {
        await trx('rooms').where({ id: roomId }).update({ cleaning_requested: true, cleaning_requested_at: fromRoom.cleaning_requested_at, cleaning_request_id: fromRoom.cleaning_request_id });
      }
      await trx('rooms').where({ id: fromRoomId }).update({ dnd: false, dnd_updated_at: new Date(), cleaning_requested: false, cleaning_requested_at: null, cleaning_request_id: null });
      const reqs = await trx('requests').where({ stay_id: id }).whereIn('status', OPEN_REQUESTS).whereNotIn('category', ROOM_BOUND_CATEGORIES).select('id');
      moved = reqs.map((r) => r.id);
      if (moved.length) {
        await trx('requests').whereIn('id', moved).update({ room_id: roomId });
        await trx('request_events').insert(moved.map((rid) => ({ request_id: rid, actor_type: 'system', action: 'room_moved', data: json({ fromRoomId, toRoomId: roomId }) })));
      }
      await record(trx, id, actor, 'moved', { fromRoomId, toRoomId: roomId, note: reason ?? null, data: moved.length ? { requestsMoved: moved } : null });
    });
  } catch (err) {
    throw translateDuplicate(err, toRoom?.number);
  }

  await revokeKeysForStay(id, { roomId: fromRoomId });
  const keys = await issueKeysForStay(id);
  for (const rid of moved) bus.publish(EVENTS.REQUEST_UPDATED, await getRequest(rid));
  publish(id, 'moved', [fromRoomId, roomId]);
  return { stay: await getStay(id), keys };
}

/** Changes the departure of a reserved or checked-in stay. Keys follow the new end time. */
export async function extendStay(id, { departure }, actor) {
  const newDeparture = new Date(departure);
  let wasCheckedIn = false;
  let roomId;
  await db.transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ACTIVE, 'change the departure of');
    if (newDeparture <= new Date()) throw badRequest('Departure must be in the future');
    assertDates(new Date(stay.check_in_at), newDeparture);
    if (stay.room_id) await assertNoOverlap(trx, stay.room_id, new Date(stay.check_in_at), newDeparture, id);
    await trx('stays').where({ id }).update({ check_out_at: newDeparture });
    wasCheckedIn = stay.status === 'checked_in';
    roomId = stay.room_id;
    const action = newDeparture > new Date(stay.check_out_at) ? 'extended' : 'shortened';
    await record(trx, id, actor, action, { roomId, data: { from: stay.check_out_at, to: newDeparture } });
  });
  if (wasCheckedIn) await extendKeysForStay(id);
  publish(id, 'extended', [roomId]);
  return getStay(id);
}

async function closeReservation(id, status, actor, { reason } = {}) {
  let roomId;
  await db.transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ['reserved'], status === 'cancelled' ? 'cancel' : 'mark as no-show');
    roomId = stay.room_id;
    await trx('stays').where({ id }).update({ status });
    await record(trx, id, actor, status === 'cancelled' ? 'cancelled' : 'no_show', { roomId, note: reason ?? null });
  });
  publish(id, status, [roomId]);
  return getStay(id);
}

export const cancelStay = (id, body, actor) => closeReservation(id, 'cancelled', actor, body);
export const markNoShow = (id, body, actor) => closeReservation(id, 'no_show', actor, body);

/** New booking code and QR. The old ones stop working; signed-in phones are signed out if asked. */
export async function reissueAccessCode(id, { signOutDevices = true, email = false } = {}, actor) {
  let access;
  let stayRecord;
  await db.transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ['checked_in', 'reserved'], 'issue an access code for');
    stayRecord = stay;
    access = await issueGuestAccess(trx, id, actor.type === 'staff' ? actor.id : null);
    await trx('stays').where({ id }).update({ access_failures: 0, access_locked_until: null });
    if (signOutDevices) await trx('guest_sessions').where({ stay_id: id }).whereNull('revoked_at').update({ revoked_at: new Date() });
    await record(trx, id, actor, 'access_code_issued', { roomId: stay.room_id, data: { signOutDevices } });
  });
  const settings = await getSettings();
  const qrUrl = qrUrlFor(settings.guest_app_login_url, access.qrToken);
  if (email) await emailGuestAccess(await loadStay(id), access.accessCode, qrUrl, settings);
  if (signOutDevices) bus.publish(EVENTS.STAY_CHANGED, { stayId: id, action: 'guest_access_reset' });

  const qrPayload = JSON.stringify({
    type: 'smartstay',
    stayId: Number(id),
    reference: stayRecord?.reference,
    qrToken: access.qrToken,
    accessCode: access.accessCode,
  });

  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 320,
      margin: 2,
      color: { dark: '#0B1F3A', light: '#FFFFFF' },
    });
  } catch (err) {
    console.error('Failed to generate QR data URL:', err.message);
  }

  return { accessCode: access.accessCode, qrToken: access.qrToken, qrUrl, qrPayload, qrDataUrl };
}

/** Admin QR Scanner: identifies a stay by QR token, JSON payload, booking code or reference. */
export async function scanGuestQr(input, { checkInNow = false, roomId = null } = {}, actor) {
  let raw = String(input || '').trim();
  let parsedToken = raw;
  let parsedReference = null;
  let parsedStayId = null;
  let parsedCode = null;

  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const obj = JSON.parse(raw);
      parsedToken = obj.qrToken || obj.token || null;
      parsedReference = obj.reference || null;
      parsedStayId = obj.stayId || obj.id || null;
      parsedCode = obj.accessCode || obj.code || null;
    } catch {
      // not JSON
    }
  } else if (raw.includes('token=')) {
    try {
      const url = new URL(raw.startsWith('http') ? raw : 'http://localhost/' + raw);
      parsedToken = url.searchParams.get('token') || parsedToken;
      parsedReference = url.searchParams.get('ref') || parsedReference;
    } catch {
      // not URL
    }
  }

  let stayRow = null;

  if (parsedToken) {
    const hashed = lookupHash(parsedToken);
    const codeMatch = await db('guest_access_codes as c')
      .where({ 'c.kind': 'qr', 'c.lookup_hash': hashed })
      .whereNull('c.revoked_at')
      .first('c.stay_id');
    if (codeMatch) {
      stayRow = await db('stays').where({ id: codeMatch.stay_id }).first();
    }
  }

  if (!stayRow && parsedCode) {
    const hashed = lookupHash(normaliseCode(parsedCode));
    const codeMatch = await db('guest_access_codes as c')
      .where({ 'c.kind': 'code', 'c.lookup_hash': hashed })
      .whereNull('c.revoked_at')
      .first('c.stay_id');
    if (codeMatch) {
      stayRow = await db('stays').where({ id: codeMatch.stay_id }).first();
    }
  }

  if (!stayRow && parsedReference) {
    stayRow = await db('stays').whereRaw('UPPER(reference) = ?', [parsedReference.toUpperCase()]).first();
  }

  if (!stayRow && parsedStayId) {
    stayRow = await db('stays').where({ id: parsedStayId }).first();
  }

  if (!stayRow && raw.length >= 4 && raw.length <= 20) {
    stayRow = await db('stays').whereRaw('UPPER(reference) = ?', [raw.toUpperCase()]).first();
  }

  if (!stayRow) {
    throw notFound('No active reservation matches this QR code');
  }

  if (['cancelled', 'no_show', 'checked_out'].includes(stayRow.status)) {
    throw badRequest('This reservation is currently ' + stayRow.status.replace('_', ' '));
  }

  let actionTaken = 'matched';
  if (checkInNow && stayRow.status === 'reserved') {
    await checkIn(stayRow.id, { roomId: roomId || stayRow.room_id }, actor);
    actionTaken = 'checked_in';
  }

  const fullStay = await getStay(stayRow.id);
  return {
    stay: fullStay,
    actionTaken,
    canCheckIn: fullStay.status === 'reserved',
    isCheckedIn: fullStay.status === 'checked_in',
  };
}

/** Revokes and re-issues the stay's digital keys, e.g. after a failure or a lost phone. */
export async function reissueKeys(id, actor) {
  const stay = await db('stays').where({ id }).first();
  if (!stay) throw notFound('Stay');
  if (stay.status !== 'checked_in') throw badRequest('Keys can only be issued for a checked-in stay');
  await revokeKeysForStay(id);
  const keys = await issueKeysForStay(id);
  await db.transaction((trx) => record(trx, id, actor, 'keys_reissued', { roomId: stay.room_id, data: { issued: keys.filter((k) => k.status === 'active').length } }));
  return { keys };
}

/* --------------------------------------------------------------- jobs */

/** Marks reservations as no-show once the arrival is long past (manual booking mode only). */
export async function markNoShows(now = new Date()) {
  const { no_show_after_hours: hours, booking_mode: mode } = await getSettings();
  if (!hours || mode !== 'manual') return 0;
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const due = await db('stays').where({ status: 'reserved' }).where('check_in_at', '<', cutoff).select('id');
  let n = 0;
  for (const { id } of due) {
    try {
      await markNoShow(id, { reason: `Not checked in ${hours} hours after arrival` }, { type: 'system' });
      n++;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }
  return n;
}
