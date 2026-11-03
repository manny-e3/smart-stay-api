import { db, json, paginate } from '../config/db.js';

/** Tables: stays (bookings), stay_guests (who is on a booking), stay_events (booking history). */

const ACTIVE = ['reserved', 'checked_in'];

const DETAIL_COLUMNS = [
  's.*',
  'g.first_name', 'g.last_name', 'g.email as guest_email', 'g.phone as guest_phone', 'g.language as guest_language', 'g.vip as guest_vip',
  'r.number as room_number', 'f.number as floor_number', 't.name as room_type_name',
];

/** Stays with primary guest, room, floor and room type. */
const withDetails = (trx = db) =>
  trx('stays as s')
    .join('guests as g', 'g.id', 's.guest_id')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .leftJoin('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('room_types as t', 't.id', 's.room_type_id');

/* ---- stays: reading ------------------------------------------------------------ */

export function findById(id, trx = db) {
  return trx('stays').where({ id }).first();
}

export function findWithDetails(id, trx = db) {
  return withDetails(trx).where('s.id', id).first(DETAIL_COLUMNS);
}

/** Locks a stay row for the rest of the transaction. */
export function lockById(id, trx) {
  return trx('stays').where({ id }).forUpdate().first();
}

/** A stay with its primary guest name and room number. */
export function findWithGuestAndRoom(id) {
  return db('stays as s')
    .join('guests as g', 'g.id', 's.guest_id')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .where('s.id', id)
    .first('s.*', 'g.first_name', 'g.last_name', 'r.number as room_number');
}

/** The room number of a stay, if it has a room. */
export function findRoomNumber(id) {
  return db('stays as s').join('rooms as r', 'r.id', 's.room_id').where('s.id', id).first('r.number');
}

/** A checked-in stay by id. */
export function findCheckedIn(id) {
  return db('stays').where({ id, status: 'checked_in' }).first('id', 'room_id', 'guest_id');
}

export function findByReference(reference) {
  return db('stays').whereRaw('UPPER(reference) = ?', [String(reference).trim().toUpperCase()]).first();
}

export async function referenceExists(reference, trx = db) {
  return Boolean(await trx('stays').where({ reference }).first('id'));
}

export function findByPmsId(connectionId, externalId) {
  return db('stays').where({ pms_connection_id: connectionId, external_id: externalId }).first();
}

export function listCheckedInForPms(connectionId) {
  return db('stays').where({ pms_connection_id: connectionId, status: 'checked_in' }).select('id', 'external_id');
}

/** The guest currently checked in to a room, if any. */
export function findCheckedInForRoom(roomId, trx = db) {
  return trx('stays').where({ room_id: roomId, status: 'checked_in' }).orderBy('check_in_at', 'desc').first('id', 'guest_id');
}

/** The checked-in stay of a room (id and reference), for "room already occupied" messages. */
export function findOccupant(roomId, trx = db) {
  return trx('stays').where({ room_id: roomId, status: 'checked_in' }).first('id', 'reference');
}

/** Ids of rooms (from the list) that have a checked-in guest. */
export async function occupiedRoomIds(roomIds) {
  if (!roomIds.length) return new Set();
  const rows = await db('stays').whereIn('room_id', roomIds).where('status', 'checked_in').distinct('room_id');
  return new Set(rows.map((r) => r.room_id));
}

export async function countCheckedIn() {
  const row = await db('stays').where({ status: 'checked_in' }).count({ n: '*' }).first();
  return Number(row.n);
}

/** Last check-out time per room. */
export function lastCheckoutByRoom(roomIds) {
  return db('stays')
    .whereIn('room_id', roomIds)
    .where('status', 'checked_out')
    .groupBy('room_id')
    .select('room_id')
    .select(db.raw('MAX(COALESCE(checked_out_at, updated_at)) AS at'));
}

/**
 * Another active stay that overlaps [from, to) in the room. A checked-in guest past their
 * departure still occupies the room, so they block any range starting before now.
 */
export function findOverlap(trx, roomId, from, to, excludeStayId = 0) {
  const now = new Date();
  return (trx || db)('stays')
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

/**
 * Stay search. arrivalRange / departureRange: { start, end } in UTC.
 * q matches reference, guest name, email, phone or room number.
 */
export function search({ status, arrivalRange, departureRange, inHouse, roomId, q, page, limit }) {
  const query = withDetails().select(DETAIL_COLUMNS).orderBy('s.check_in_at', 'desc');
  if (status?.length) query.whereIn('s.status', status);
  if (inHouse) query.where('s.status', 'checked_in');
  if (roomId) query.where('s.room_id', roomId);
  if (arrivalRange) query.where('s.check_in_at', '>=', arrivalRange.start).where('s.check_in_at', '<', arrivalRange.end);
  if (departureRange) query.where('s.check_out_at', '>=', departureRange.start).where('s.check_out_at', '<', departureRange.end);
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
  return paginate(query, { page, limit });
}

/** Reservations arriving before `before` that are not past departure (front desk arrivals). */
export function listArrivals(before, now) {
  return withDetails().where('s.status', 'reserved').where('s.check_in_at', '<', before).where('s.check_out_at', '>', now).orderBy('s.check_in_at').select(DETAIL_COLUMNS);
}

/** Checked-in stays departing within [start, end). */
export function listDepartures(start, end) {
  return withDetails().where('s.status', 'checked_in').where('s.check_out_at', '>=', start).where('s.check_out_at', '<', end).orderBy('s.check_out_at').select(DETAIL_COLUMNS);
}

/** Checked-in stays that should have left before the cutoff. */
export function listOverdue(cutoff) {
  return withDetails().where('s.status', 'checked_in').where('s.check_out_at', '<', cutoff).orderBy('s.check_out_at').select(DETAIL_COLUMNS);
}

/** Every stay a guest is on (as primary guest or companion), newest first, with details. */
export function listForGuest(guestId) {
  return withDetails()
    .join('stay_guests as sg', 'sg.stay_id', 's.id')
    .where('sg.guest_id', guestId)
    .orderBy('s.check_in_at', 'desc')
    .select(DETAIL_COLUMNS);
}

/** Reservations not checked in by the cutoff (no-show job). */
export function listReservedArrivingBefore(cutoff) {
  return db('stays').where({ status: 'reserved' }).where('check_in_at', '<', cutoff).select('id');
}

/** The guest's next current or upcoming stay, other than excludeId. */
export function findNextActiveForGuest(guestId, excludeId, trx = db) {
  return trx('stays').where({ guest_id: guestId }).whereIn('status', ACTIVE).whereNot('id', excludeId).orderBy('check_in_at', 'desc').first();
}

/** The guest's latest current or upcoming stay, as primary guest or companion, with the room number. */
export function findActiveForGuestWithRoom(guestId) {
  return db('stays as s')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .where(function () {
      this.where('s.guest_id', guestId).orWhereExists(function () {
        this.select('*').from('stay_guests as sg').whereRaw('sg.stay_id = s.id').andWhere('sg.guest_id', guestId);
      });
    })
    .whereIn('s.status', ACTIVE)
    .orderBy('s.check_in_at', 'desc')
    .first('s.id as stay_id', 's.status', 's.room_id', 'r.number as room_number');
}

/** The guest's latest current or upcoming stay as primary guest, else their latest stay of any kind. */
export async function findLatestForGuest(guestId) {
  return (
    (await db('stays').where({ guest_id: guestId }).whereIn('status', ACTIVE).orderBy('check_in_at', 'desc').first()) ||
    (await db('stays').where({ guest_id: guestId }).orderBy('check_out_at', 'desc').first())
  );
}

/** Stays where the guest is the primary guest, newest first, with room number and the room's type (guest app history). */
export function historyForGuest(guestId) {
  return db('stays as s')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .leftJoin('room_types as rt', 'rt.id', 'r.room_type_id')
    .where('s.guest_id', guestId)
    .orderBy('s.check_in_at', 'desc')
    .select('s.id', 's.reference', 's.status', 's.check_in_at', 's.check_out_at', 's.adults', 's.children', 'r.number as room_number', 'rt.name as room_type');
}

/** Stays where the guest is the primary guest, newest first, with the booked room type (guest app "my bookings"). */
export function bookingsForGuest(guestId) {
  return db('stays as s')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .leftJoin('room_types as rt', 'rt.id', 's.room_type_id')
    .where('s.guest_id', guestId)
    .orderBy('s.check_in_at', 'desc')
    .select('s.id', 's.reference', 's.status', 's.check_in_at as arrival', 's.check_out_at as departure', 's.adults', 's.children', 's.notes', 'r.number as roomNumber', 'rt.name as roomType');
}

/** How many stays the guest has as primary guest. */
export async function countForGuest(guestId) {
  const row = await db('stays').where({ guest_id: guestId }).count({ n: '*' }).first();
  return Number(row.n);
}

/** The guest's newest stay as primary guest (any status). */
export function findNewestForGuest(guestId) {
  return db('stays').where({ guest_id: guestId }).orderBy('check_in_at', 'desc').first('id', 'room_id');
}

/** The guest's newest checked-in stay as primary guest. */
export function findCheckedInForGuest(guestId) {
  return db('stays').where({ guest_id: guestId, status: 'checked_in' }).orderBy('check_in_at', 'desc').first();
}

/** Checked-in stays with guest names in the given rooms (board). */
export function checkedInWithGuestForRooms(roomIds) {
  return db('stays as s')
    .join('guests as g', 'g.id', 's.guest_id')
    .whereIn('s.room_id', roomIds)
    .where('s.status', 'checked_in')
    .select('s.id', 's.room_id', 's.check_in_at', 's.check_out_at', 'g.first_name', 'g.last_name');
}

/** Reservations in the given rooms that arrive before `before` and are not past departure (board). */
export function reservedArrivingForRooms(roomIds, before, now) {
  return db('stays').whereIn('room_id', roomIds).where('status', 'reserved').where('check_in_at', '<', before).where('check_out_at', '>', now).select('id', 'room_id', 'check_in_at');
}

/** The checked-in stay of a room with guest contact details (room detail panel). */
export function checkedInWithGuestForRoom(roomId) {
  return db('stays as s')
    .join('guests as g', 'g.id', 's.guest_id')
    .where({ 's.room_id': roomId, 's.status': 'checked_in' })
    .first('s.id', 's.reference', 's.check_in_at', 's.check_out_at', 's.checked_in_at', 's.adults', 's.children', 'g.id as guest_id', 'g.first_name', 'g.last_name', 'g.phone', 'g.email', 'g.language', 'g.vip');
}

/* ---- stays: writing -------------------------------------------------------------- */

export async function create(fields, trx = db) {
  const [id] = await trx('stays').insert(fields);
  return id;
}

export function update(id, fields, trx = db) {
  return trx('stays').where({ id }).update(fields);
}

/* ---- stay_guests ------------------------------------------------------------------ */

/** Puts a guest on a stay. A guest already on the stay is left as is. */
export function addGuest(stayId, guestId, isPrimary, trx = db) {
  return trx('stay_guests').insert({ stay_id: stayId, guest_id: guestId, is_primary: isPrimary }).onConflict(['stay_id', 'guest_id']).ignore();
}

export function isGuestOnStay(stayId, guestId) {
  return db('stay_guests').where({ stay_id: stayId, guest_id: guestId }).first();
}

/** Everyone on a stay, primary guest first. */
export function guestsOnStay(stayId) {
  return db('stay_guests as sg').join('guests as g', 'g.id', 'sg.guest_id').where('sg.stay_id', stayId).orderBy('sg.is_primary', 'desc').select('g.id', 'g.first_name', 'g.last_name', 'g.email', 'g.phone', 'sg.is_primary');
}

/** Ids and last names of everyone on a stay (sign-in by reference + last name). */
export function guestNamesOnStay(stayId) {
  return db('stay_guests as sg').join('guests as g', 'g.id', 'sg.guest_id').where('sg.stay_id', stayId).select('g.id', 'g.last_name');
}

/* ---- stay_events ------------------------------------------------------------------- */

/** One line in a booking's history. actorType: staff | guest | system | pms */
export function addEvent({ stayId, actorType, staffId = null, action, fromRoomId = null, toRoomId = null, note = null, data = null }, trx = db) {
  return trx('stay_events').insert({
    stay_id: stayId,
    actor_type: actorType,
    staff_id: staffId,
    action,
    from_room_id: fromRoomId,
    to_room_id: toRoomId,
    note,
    data: json(data),
  });
}

/** A stay's history, oldest first, with staff names and room numbers. */
export function history(stayId) {
  return db('stay_events as e')
    .leftJoin('staff as st', 'st.id', 'e.staff_id')
    .leftJoin('rooms as fr', 'fr.id', 'e.from_room_id')
    .leftJoin('rooms as tr', 'tr.id', 'e.to_room_id')
    .where('e.stay_id', stayId)
    .orderBy('e.id')
    .select('e.*', 'st.name as staff_name', 'fr.number as from_room', 'tr.number as to_room');
}
