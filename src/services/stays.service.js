import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { transaction } from '../config/db.js';
import * as Stay from '../models/stay.model.js';
import * as Room from '../models/room.model.js';
import * as Guest from '../models/guest.model.js';
import * as GuestAccess from '../models/guestAccess.model.js';
import * as Request from '../models/request.model.js';
import * as Alert from '../models/alert.model.js';
import * as DigitalKey from '../models/digitalKey.model.js';
import * as Feedback from '../models/feedback.model.js';
import { recordAudit } from './audit.service.js';
import { accessCode, bookingReference, lookupHash, qrToken, normaliseCode } from '../utils/crypto.js';
import { applyGuestPreferences } from './preferences.service.js';
import { AppError, badRequest, conflict, notFound } from '../utils/errors.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { dayRange, todayRange } from '../utils/time.js';
import { getSettings } from './settings.service.js';
import { issueKeysForStay, revokeKeysForStay, extendKeysForStay, toKey } from './keys.service.js';
import { getRequest } from './requests.service.js';
import { emailGuestReservation } from './stayEmail.service.js';

export { emailGuestReservation };

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

/** Writes the stay history line and the audit entry for a change. */
async function record(trx, stayId, actor, action, { roomId = null, fromRoomId = null, toRoomId = null, note = null, data = null } = {}) {
  const settings = await getSettings();
  const override = actor.type === 'staff' && settings.booking_mode === 'pms';
  const payload = override ? { ...(data || {}), manualOverride: true } : data;
  await Stay.addEvent(
    { stayId, actorType: actor.type === 'staff' ? 'staff' : actor.type, staffId: actor.type === 'staff' ? actor.id : null, action, fromRoomId, toRoomId, note, data: payload },
    trx,
  );
  await recordAudit(
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

async function loadStay(id, trx) {
  const s = await Stay.findWithDetails(id, trx);
  return s ? toStay(s) : null;
}

async function lockStay(trx, id) {
  const stay = await Stay.lockById(id, trx);
  if (!stay) throw notFound('Stay');
  return stay;
}

function assertStatus(stay, allowed, action) {
  if (!allowed.includes(stay.status)) throw badRequest(`Cannot ${action} a stay that is ${stay.status.replace('_', ' ')}`);
}

async function resolveRoom(trx, roomId, { lock = false } = {}) {
  const room = lock ? await Room.lockById(roomId, trx) : await Room.findById(roomId, trx);
  if (!room || !room.is_active) throw badRequest('Room not found or inactive');
  return room;
}

/** Room type id by name: exact, then ignoring case, then a partial match ("Deluxe Suite" matches "Suite"). */
async function resolveRoomType(trx, name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  const exact = await Room.findRoomType(trimmed, trx);
  if (exact) return exact.id;
  const ignoringCase = await Room.findRoomTypeIgnoreCase(trimmed, trx);
  if (ignoringCase) return ignoringCase.id;
  const lower = trimmed.toLowerCase();
  const matched = (await Room.roomTypeNames(trx)).find((t) => lower.includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(lower));
  if (matched) return matched.id;
  throw badRequest(`Unknown room type "${name}"`);
}

/**
 * Another active stay that overlaps [from, to) in the room. A checked-in guest past their
 * departure still occupies the room, so they block any range starting before now.
 */
export const findOverlap = (trx, roomId, from, to, excludeStayId = 0) => Stay.findOverlap(trx, roomId, from, to, excludeStayId);

async function assertNoOverlap(trx, roomId, from, to, excludeStayId) {
  const clash = await Stay.findOverlap(trx, roomId, from, to, excludeStayId);
  if (clash) {
    const room = await Room.findNumber(roomId, trx);
    throw conflict(`Room ${room?.number ?? roomId} is booked for those dates (${clash.reference}, ${clash.status.replace('_', ' ')})`);
  }
}

function assertDates(arrival, departure) {
  if (!(departure > arrival)) throw badRequest('Departure must be after arrival');
}

async function uniqueReference(trx) {
  for (let i = 0; i < 10; i++) {
    const ref = bookingReference();
    if (!(await Stay.referenceExists(ref, trx))) return ref;
  }
  throw new Error('Could not generate a unique booking reference');
}

/** Finds or creates a guest from { id } or profile fields. PMS guests are matched by their PMS id. */
export async function upsertGuest(trx, input, { pmsConnectionId = null } = {}) {
  if (input.id) {
    const g = await Guest.findById(input.id, trx);
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
    const existing = await Guest.findByPmsId(pmsConnectionId, input.externalId, trx);
    if (existing) {
      await Guest.update(existing.id, fields, trx);
      return existing.id;
    }
    return Guest.create({ ...fields, pms_connection_id: pmsConnectionId, external_id: input.externalId }, trx);
  }
  return Guest.create(fields, trx);
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
  await GuestAccess.revokeCodesForStay(stayId, trx);
  const insertUnique = async (kind, make) => {
    for (let i = 0; i < 10; i++) {
      const value = make();
      try {
        await GuestAccess.insertCode({ stayId, kind, lookupHash: lookupHash(value), createdBy }, trx);
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
    Stay.guestsOnStay(id),
    Stay.history(id),
    Request.listForStaySummary(id),
    DigitalKey.listForStay(id),
    Feedback.listForStay(id),
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

export async function listStays({ arrivalDate, departureDate, ...filters }) {
  const { timezone } = await getSettings();
  const result = await Stay.search({
    ...filters,
    arrivalRange: arrivalDate ? dayRange(arrivalDate, timezone) : undefined,
    departureRange: departureDate ? dayRange(departureDate, timezone) : undefined,
  });
  return { ...result, items: result.items.map(toStay) };
}

/** The front desk's day: arrivals, departures, in-house guests, overdue check-outs and free rooms. */
export async function frontDeskToday(now = new Date()) {
  const settings = await getSettings();
  const { start, end } = todayRange(settings.timezone, now);
  const graceCutoff = new Date(now.getTime() - settings.checkout_grace_minutes * 60_000);

  const [arrivals, departures, overdue, occupied, totalRooms] = await Promise.all([
    Stay.listArrivals(end, now),
    Stay.listDepartures(start, end),
    Stay.listOverdue(graceCutoff),
    Stay.countCheckedIn(),
    Room.countActive(),
  ]);
  return {
    date: start,
    timezone: settings.timezone,
    counts: { arrivals: arrivals.length, departures: departures.length, overdueCheckOuts: overdue.length, inHouse: occupied, vacantRooms: totalRooms - occupied, totalRooms },
    arrivals: arrivals.map((s) => ({ ...toStay(s), late: new Date(s.check_in_at) < start })),
    departures: departures.map(toStay),
    overdueCheckOuts: overdue.map(toStay),
  };
}

/** Rooms free for the whole of [from, to). */
export async function availability({ from, to, roomType }) {
  assertDates(from, to);
  const free = [];
  for (const r of await Room.listActiveWithType(roomType)) {
    if (!(await Stay.findOverlap(null, r.id, from, to))) free.push({ id: r.id, number: r.number, floor: r.floor, roomType: r.room_type });
  }
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
  const pmsConnectionId = actor.type === 'pms' ? actor.connectionId : null;

  const id = await transaction(async (trx) => {
    const guestId = await upsertGuest(trx, input.guest, { pmsConnectionId });
    let room = null;
    if (input.roomId) {
      room = await resolveRoom(trx, input.roomId, { lock: true });
      await assertNoOverlap(trx, room.id, arrival, departure);
    }
    let roomTypeId = room?.room_type_id ?? null;
    if (input.roomType) {
      try {
        roomTypeId = await resolveRoomType(trx, input.roomType);
      } catch (err) {
        // An unknown type name is fine when the room already says what type it is.
        if (!room?.room_type_id) throw err;
      }
    }
    const stayId = await Stay.create(
      {
        reference: input.reference || (await uniqueReference(trx)),
        source: actor.type === 'pms' ? 'pms' : 'manual',
        pms_connection_id: pmsConnectionId,
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
      },
      trx,
    );
    await Stay.addGuest(stayId, guestId, true, trx);
    for (const companion of input.companions || []) {
      const cid = await upsertGuest(trx, companion, { pmsConnectionId });
      if (cid !== guestId) await Stay.addGuest(stayId, cid, false, trx);
    }
    await record(trx, stayId, actor, 'created', { toRoomId: room?.id, data: { arrival, departure, walkIn: Boolean(input.checkInNow) } });
    return stayId;
  });

  publish(id, 'created', [input.roomId]);
  if (input.checkInNow) return checkIn(id, { roomId: input.roomId }, actor);

  // A reservation gets guest app access codes straight away, so the guest can sign in.
  const access = await transaction((trx) => issueGuestAccess(trx, id, actor.type === 'staff' ? actor.id : null));
  const settings = await getSettings();
  const qrUrl = qrUrlFor(settings.guest_app_login_url, access.qrToken);
  const stay = await getStay(id);
  if (!env.isTest) await emailGuestReservation(stay, access.accessCode, qrUrl, settings, false);
  return { stay, accessCode: access.accessCode, qrToken: access.qrToken, qrUrl };
}

/** Edits a booking. Dates and room of a checked-in stay change through extend and move instead. */
export async function updateStay(id, patch, actor) {
  let extended = false;
  const roomIds = [];
  await transaction(async (trx) => {
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
    for (const k of ['adults', 'children', 'notes']) {
      if (patch[k] !== undefined) {
        update[k] = patch[k];
        changes[k] = patch[k];
      }
    }
    for (const companion of patch.addGuests || []) {
      const cid = await upsertGuest(trx, companion);
      await Stay.addGuest(id, cid, false, trx);
      changes.addedGuests = (changes.addedGuests || 0) + 1;
    }
    if (!Object.keys(update).length && !changes.addedGuests) return;
    if (Object.keys(update).length) await Stay.update(id, update, trx);
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
    await transaction(async (trx) => {
      const stay = await lockStay(trx, id);
      assertStatus(stay, ['reserved'], 'check in');
      const targetRoomId = roomId ?? stay.room_id;
      if (!targetRoomId) throw badRequest('Choose a room before checking the guest in');
      room = await resolveRoom(trx, targetRoomId, { lock: true });
      if (new Date(stay.check_out_at) <= now) throw badRequest('The departure date has passed. Change the dates before checking in.');

      const occupant = await Stay.findOccupant(room.id, trx);
      if (occupant) throw conflict(`Room ${room.number} already has a checked-in guest (${occupant.reference})`);
      await assertNoOverlap(trx, room.id, now, new Date(stay.check_out_at), id);

      await Stay.update(id, { status: 'checked_in', room_id: room.id, room_type_id: stay.room_type_id ?? room.room_type_id, checked_in_at: now, access_failures: 0, access_locked_until: null }, trx);
      await Room.update(room.id, { dnd: false, dnd_updated_at: now, ...Room.CLEAR_CLEANING }, trx);

      access = await issueGuestAccess(trx, id, actor.type === 'staff' ? actor.id : null);
      await record(trx, id, actor, 'checked_in', { toRoomId: room.id, fromRoomId: stay.room_id && stay.room_id !== room.id ? stay.room_id : null });
    });
  } catch (err) {
    throw translateDuplicate(err, room?.number);
  }

  const keys = await issueKeysForStay(id);
  const stay = await getStay(id);
  const warnings = [];
  for (const a of await Alert.openCriticalTitlesForRoom(stay.room.id)) warnings.push(`Open critical alert in this room: ${a.title}`);
  if (!keys.length) warnings.push('This room has no digital lock; give the guest a key card');
  if (keys.some((k) => k.status === 'failed')) warnings.push('A digital key could not be issued; give the guest a key card and retry the keys');

  let preferences = null;
  if (settings.apply_guest_preferences_on_check_in) {
    preferences = await applyGuestPreferences(id, { type: 'system' });
    if (preferences?.failed) warnings.push('Some of the guest’s saved preferences could not be applied to the room');
  }

  const qrUrl = qrUrlFor(settings.guest_app_login_url, access.qrToken);
  await emailGuestReservation(stay, access.accessCode, qrUrl, settings, true);
  publish(id, 'checked_in', [stay.room.id]);
  return { stay, accessCode: access.accessCode, qrToken: access.qrToken, qrUrl, keys, warnings, preferences };
}

/** Closes open guest requests when the guest leaves; maintenance requests stay with the room. */
async function closeGuestRequests(trx, stayId, reason) {
  const open = await Request.listOpenForStay(stayId, OPEN_REQUESTS, ROOM_BOUND_CATEGORIES, trx);
  for (const r of open) {
    await Request.update(r.id, { status: 'cancelled' }, trx);
    await Request.addEvent({ requestId: r.id, actorType: 'system', action: 'status_changed', fromStatus: r.status, toStatus: 'cancelled', note: reason }, trx);
  }
  return open.map((r) => r.id);
}

/** Checks a guest out: guest app access ends, keys are revoked, guest requests closed. */
export async function checkOut(id, actor, { note } = {}) {
  const now = new Date();
  const settings = await getSettings();
  let roomId;
  let closed = [];
  await transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ['checked_in'], 'check out');
    roomId = stay.room_id;
    await Stay.update(id, { status: 'checked_out', checked_out_at: now }, trx);
    await GuestAccess.revokeCodesForStay(id, trx);
    // Registered guest accounts (password) stay signed in and move to their next stay, or none.
    for (const ps of await GuestAccess.listPasswordSessionsForStay(id, trx)) {
      const nextStay = await Stay.findNextActiveForGuest(ps.guest_id, id, trx);
      await GuestAccess.updateSession(ps.id, { stay_id: nextStay?.id || null }, trx);
    }
    // Anonymous / one-stay sessions end with the stay.
    await GuestAccess.revokeSessionsForStay(id, { exceptMethod: 'password' }, trx);
    await Guest.deleteDevicesForStay(id, trx);
    await Room.update(roomId, { dnd: false, dnd_updated_at: now, ...Room.CLEAR_CLEANING }, trx);
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
    await transaction(async (trx) => {
      const stay = await lockStay(trx, id);
      assertStatus(stay, ['checked_in'], 'move');
      if (stay.room_id === roomId) throw badRequest('The guest is already in this room');
      fromRoomId = stay.room_id;
      const locked = await Room.lockMany([fromRoomId, roomId], trx);
      toRoom = locked.find((r) => r.id === roomId);
      if (!toRoom || !toRoom.is_active) throw badRequest('Room not found or inactive');
      const occupant = await Stay.findOccupant(roomId, trx);
      if (occupant) throw conflict(`Room ${toRoom.number} already has a checked-in guest (${occupant.reference})`);
      await assertNoOverlap(trx, roomId, new Date(), new Date(stay.check_out_at), id);

      await Stay.update(id, { room_id: roomId, room_type_id: toRoom.room_type_id ?? stay.room_type_id }, trx);
      // A pending cleaning request follows the guest, like their other requests.
      const fromRoom = locked.find((r) => r.id === fromRoomId);
      if (fromRoom?.cleaning_requested) {
        await Room.update(roomId, { cleaning_requested: true, cleaning_requested_at: fromRoom.cleaning_requested_at, cleaning_request_id: fromRoom.cleaning_request_id }, trx);
      }
      await Room.update(fromRoomId, { dnd: false, dnd_updated_at: new Date(), ...Room.CLEAR_CLEANING }, trx);
      moved = (await Request.listOpenForStay(id, OPEN_REQUESTS, ROOM_BOUND_CATEGORIES, trx)).map((r) => r.id);
      if (moved.length) {
        await Request.updateMany(moved, { room_id: roomId }, trx);
        for (const rid of moved) await Request.addEvent({ requestId: rid, actorType: 'system', action: 'room_moved', data: { fromRoomId, toRoomId: roomId } }, trx);
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
  await transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ACTIVE, 'change the departure of');
    if (newDeparture <= new Date()) throw badRequest('Departure must be in the future');
    assertDates(new Date(stay.check_in_at), newDeparture);
    if (stay.room_id) await assertNoOverlap(trx, stay.room_id, new Date(stay.check_in_at), newDeparture, id);
    await Stay.update(id, { check_out_at: newDeparture }, trx);
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
  await transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ['reserved'], status === 'cancelled' ? 'cancel' : 'mark as no-show');
    roomId = stay.room_id;
    await Stay.update(id, { status }, trx);
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
  await transaction(async (trx) => {
    const stay = await lockStay(trx, id);
    assertStatus(stay, ['checked_in', 'reserved'], 'issue an access code for');
    stayRecord = stay;
    access = await issueGuestAccess(trx, id, actor.type === 'staff' ? actor.id : null);
    await Stay.update(id, { access_failures: 0, access_locked_until: null }, trx);
    if (signOutDevices) await GuestAccess.revokeSessionsForStay(id, {}, trx);
    await record(trx, id, actor, 'access_code_issued', { roomId: stay.room_id, data: { signOutDevices } });
  });
  const settings = await getSettings();
  const qrUrl = qrUrlFor(settings.guest_app_login_url, access.qrToken);
  if (email) await emailGuestReservation(await loadStay(id), access.accessCode, qrUrl, settings, true);
  if (signOutDevices) bus.publish(EVENTS.STAY_CHANGED, { stayId: id, action: 'guest_access_reset' });

  const qrPayload = JSON.stringify({ type: 'smartstay', stayId: Number(id), reference: stayRecord?.reference, qrToken: access.qrToken, accessCode: access.accessCode });
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 320, margin: 2, color: { dark: '#0B1F3A', light: '#FFFFFF' } });
  } catch (err) {
    console.error('Failed to generate QR data URL:', err.message);
  }
  return { accessCode: access.accessCode, qrToken: access.qrToken, qrUrl, qrPayload, qrDataUrl };
}

/** Reads what an admin QR scan contains: a QR token, a JSON payload, a login link, a booking code or a reference. */
function parseScan(input) {
  const raw = String(input || '').trim();
  const parsed = { raw, token: raw, reference: null, stayId: null, code: null };
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const obj = JSON.parse(raw);
      Object.assign(parsed, { token: obj.qrToken || obj.token || null, reference: obj.reference || null, stayId: obj.stayId || obj.id || null, code: obj.accessCode || obj.code || null });
    } catch {
      // Not JSON: treat as text.
    }
  } else if (raw.includes('token=')) {
    try {
      const url = new URL(raw.startsWith('http') ? raw : 'http://localhost/' + raw);
      parsed.token = url.searchParams.get('token') || parsed.token;
      parsed.reference = url.searchParams.get('ref') || parsed.reference;
    } catch {
      // Not a URL: treat as text.
    }
  }
  return parsed;
}

/** Admin QR Scanner: identifies a stay by QR token, JSON payload, booking code or reference. */
export async function scanGuestQr(input, { checkInNow = false, roomId = null } = {}, actor) {
  const scan = parseScan(input);
  let stayRow = null;
  if (scan.token) stayRow = await GuestAccess.findStayByLiveCode('qr', lookupHash(scan.token));
  if (!stayRow && scan.code) stayRow = await GuestAccess.findStayByLiveCode('code', lookupHash(normaliseCode(scan.code)));
  if (!stayRow && scan.reference) stayRow = await Stay.findByReference(scan.reference);
  if (!stayRow && scan.stayId) stayRow = await Stay.findById(scan.stayId);
  if (!stayRow && scan.raw.length >= 4 && scan.raw.length <= 20) stayRow = await Stay.findByReference(scan.raw);

  if (!stayRow) throw notFound('No active reservation matches this QR code');
  if (['cancelled', 'no_show', 'checked_out'].includes(stayRow.status)) throw badRequest('This reservation is currently ' + stayRow.status.replace('_', ' '));

  let actionTaken = 'matched';
  if (checkInNow && stayRow.status === 'reserved') {
    await checkIn(stayRow.id, { roomId: roomId || stayRow.room_id }, actor);
    actionTaken = 'checked_in';
  }
  const fullStay = await getStay(stayRow.id);
  return { stay: fullStay, actionTaken, canCheckIn: fullStay.status === 'reserved', isCheckedIn: fullStay.status === 'checked_in' };
}

/** Revokes and re-issues the stay's digital keys, e.g. after a failure or a lost phone. */
export async function reissueKeys(id, actor) {
  const stay = await Stay.findById(id);
  if (!stay) throw notFound('Stay');
  if (stay.status !== 'checked_in') throw badRequest('Keys can only be issued for a checked-in stay');
  await revokeKeysForStay(id);
  const keys = await issueKeysForStay(id);
  await transaction((trx) => record(trx, id, actor, 'keys_reissued', { roomId: stay.room_id, data: { issued: keys.filter((k) => k.status === 'active').length } }));
  return { keys };
}

/* --------------------------------------------------------------- jobs */

/** Background job: marks reservations as no-show once the arrival is long past (manual booking mode only). */
export async function markNoShows(now = new Date()) {
  const { no_show_after_hours: hours, booking_mode: mode } = await getSettings();
  if (!hours || mode !== 'manual') return 0;
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  let n = 0;
  for (const { id } of await Stay.listReservedArrivingBefore(cutoff)) {
    try {
      await markNoShow(id, { reason: `Not checked in ${hours} hours after arrival` }, { type: 'system' });
      n++;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }
  return n;
}
