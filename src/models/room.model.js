import { db, json } from '../config/db.js';

/** Tables: rooms, floors, room_types. */

export const CLEAR_CLEANING = { cleaning_requested: false, cleaning_requested_at: null, cleaning_request_id: null };

/* ---- rooms ------------------------------------------------------------------- */

export function findById(id, trx = db) {
  return trx('rooms').where({ id }).first();
}

export function findActive(id, trx = db) {
  return trx('rooms').where({ id, is_active: true }).first();
}

export function findByNumber(number, trx = db) {
  return trx('rooms').where({ number }).first();
}

/** Another room already using this number. */
export function findByNumberExcept(number, excludeId, trx = db) {
  return trx('rooms').where({ number }).whereNot({ id: excludeId }).first();
}

/** Room by PMS room code, or by number. */
export function findByPmsCodeOrNumber(code) {
  return db('rooms').where({ pms_code: code }).orWhere({ number: code }).orderByRaw('pms_code = ? DESC', [code]).first('id', 'number', 'is_active');
}

/** Just the room number. */
export function findNumber(id, trx = db) {
  return trx('rooms').where({ id }).first('number');
}

/** The room whose pending cleaning request is this request. */
export function findByCleaningRequest(requestId, trx = db) {
  return trx('rooms').where({ cleaning_request_id: requestId }).first('id');
}

/** Locks rooms in id order (so two transactions can never deadlock) until the transaction ends. */
export function lockMany(ids, trx) {
  return trx('rooms').whereIn('id', ids).orderBy('id').forUpdate();
}

export function lockById(id, trx) {
  return trx('rooms').where({ id }).forUpdate().first();
}

export async function create(fields, trx = db) {
  const row = { ...fields };
  if (Array.isArray(row.images)) row.images = json(row.images);
  const [id] = await trx('rooms').insert(row);
  return id;
}

export function update(id, fields, trx = db) {
  const patch = { ...fields };
  if (Array.isArray(patch.images)) patch.images = json(patch.images);
  return trx('rooms').where({ id }).update(patch);
}

export function remove(id, trx = db) {
  return trx('rooms').where({ id }).del();
}

export async function countAll() {
  const row = await db('rooms').count({ n: '*' }).first();
  return Number(row.n);
}

export async function countActive() {
  const row = await db('rooms').where({ is_active: true }).count({ n: '*' }).first();
  return Number(row.n);
}

/** Whether a room has stays, requests, alerts or audit entries (then it is deactivated, not deleted). */
export async function hasHistory(id, trx = db) {
  const counts = await Promise.all(['stays', 'requests', 'alerts', 'audit_log'].map((t) => trx(t).where({ room_id: id }).count({ c: '*' }).first()));
  return counts.some((row) => Number(row?.c) > 0);
}

/**
 * Active rooms with floor, type, price, DND and cleaning flags, for the board.
 * Optional filters: roomIds, floor (numbers), roomType (names).
 */
export function listForBoard({ roomIds, floor, roomType } = {}) {
  const q = db('rooms as r')
    .join('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('room_types as t', 't.id', 'r.room_type_id')
    .where('r.is_active', true)
    .select(
      'r.id', 'r.number', 'r.base_price', 't.base_price as type_base_price', 'r.dnd', 'r.dnd_updated_at', 'r.cleaning_requested', 'r.cleaning_requested_at',
      'r.image_url as imageUrl', 'r.images', 'f.id as floor_id', 'f.number as floor_number', 'f.name as floor_name', 't.id as type_id', 't.name as type_name',
    );
  if (roomIds) q.whereIn('r.id', roomIds);
  if (floor?.length) q.whereIn('f.number', floor);
  if (roomType?.length) q.whereIn('t.name', roomType);
  return q;
}

/** One room with floor number, type name and price, after an edit. */
export function findWithFloorAndType(id, trx = db) {
  return trx('rooms as r')
    .join('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('room_types as t', 't.id', 'r.room_type_id')
    .where('r.id', id)
    .first('r.id', 'r.number', 'r.base_price', 'r.dnd', 'r.is_active as isActive', 'r.image_url as imageUrl', 'r.images', 'f.number as floor', 't.name as roomType', 't.base_price as typeBasePrice');
}

/** One room with floor and type, for the guest app home screen. */
export function findForGuest(id) {
  return db('rooms as r').join('floors as f', 'f.id', 'r.floor_id').leftJoin('room_types as t', 't.id', 'r.room_type_id').where('r.id', id).first('r.number', 'r.image_url', 'f.number as floor', 't.name as room_type');
}

/** All rooms with floor number and type name (mapping screen). */
export function listWithFloorAndType() {
  return db('rooms as r').join('floors as f', 'f.id', 'r.floor_id').leftJoin('room_types as t', 't.id', 'r.room_type_id').select('r.*', 'f.number as floor_number', 't.name as type_name');
}

/** Active rooms, optionally of one type name, ordered by floor and number (availability). */
export function listActiveWithType(roomType) {
  const q = db('rooms as r')
    .join('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('room_types as t', 't.id', 'r.room_type_id')
    .where('r.is_active', true)
    .select('r.id', 'r.number', 'f.number as floor', 't.name as room_type')
    .orderBy(['f.number', 'r.number']);
  if (roomType) q.where('t.name', roomType);
  return q;
}

/** Active rooms of a room type (by id), or whose type name looks like typeNameLike (guest bookings). */
export function listActiveForBooking({ roomTypeId, typeNameLike }) {
  return db('rooms as r')
    .leftJoin('room_types as rt', 'rt.id', 'r.room_type_id')
    .leftJoin('floors as f', 'f.id', 'r.floor_id')
    .where('r.is_active', true)
    .where((w) => {
      if (roomTypeId) w.where('r.room_type_id', roomTypeId);
      else w.whereILike('rt.name', `%${typeNameLike}%`);
    })
    .select('r.id', 'r.number', 'f.number as floor')
    .orderBy('r.number');
}

/** Every active room with its floor number, by room number (guest bookings fallback). */
export function listActiveWithFloor() {
  return db('rooms as r').leftJoin('floors as f', 'f.id', 'r.floor_id').where({ 'r.is_active': true }).orderBy('r.number').select('r.id', 'r.number', 'f.number as floor');
}

/**
 * Active rooms matched by a rule target:
 * { scope: 'all' } | { scope: 'floors', floors } | { scope: 'rooms', roomIds } | { scope: 'roomTypes', roomTypes }
 */
export function listForTarget(target) {
  const q = db('rooms as r').leftJoin('room_types as t', 't.id', 'r.room_type_id').join('floors as f', 'f.id', 'r.floor_id').where('r.is_active', true).select('r.id', 'r.number');
  if (target.scope === 'floors') q.whereIn('f.number', target.floors);
  if (target.scope === 'rooms') q.whereIn('r.id', target.roomIds);
  if (target.scope === 'roomTypes') q.whereIn('t.name', target.roomTypes);
  return q;
}

/** Creates or updates a room by its number (mapping import). */
export function upsertByNumber({ number, floorId, roomTypeId, isActive }, trx) {
  return trx('rooms').insert({ number, floor_id: floorId, room_type_id: roomTypeId, is_active: isActive }).onConflict('number').merge(['floor_id', 'room_type_id', 'is_active']);
}

/** Deactivates active rooms whose number is not in the list. Returns how many. */
export function deactivateAllExcept(numbers, trx) {
  return trx('rooms').whereNotIn('number', numbers.length ? numbers : ['']).where('is_active', true).update({ is_active: false });
}

export async function idsByNumber(trx = db) {
  return new Map((await trx('rooms').select('id', 'number')).map((r) => [r.number, r.id]));
}

/* ---- floors ------------------------------------------------------------------- */

export function listFloors() {
  return db('floors').orderBy('number');
}

/** The floor with this number, created as "Floor N" when it does not exist yet. */
export async function findOrCreateFloor(number, trx = db) {
  const floor = await trx('floors').where({ number }).first();
  if (floor) return floor;
  const [id] = await trx('floors').insert({ number, name: `Floor ${number}` });
  return { id, number };
}

export function upsertFloor(number, name, trx) {
  return trx('floors').insert({ number, name: name ?? null }).onConflict('number').merge(['name']);
}

export async function floorIdsByNumber(trx = db) {
  return new Map((await trx('floors').select('id', 'number')).map((f) => [f.number, f.id]));
}

/** Deletes floors not in the list that no room uses any more. */
export function deleteUnusedFloorsExcept(numbers, trx) {
  return trx('floors').whereNotIn('number', numbers.length ? numbers : [-99999]).whereNotExists(trx('rooms').whereRaw('rooms.floor_id = floors.id')).del();
}

/* ---- room_types ------------------------------------------------------------------ */

export function listRoomTypes() {
  return db('room_types').orderBy('name');
}

export function allRoomTypes() {
  return db('room_types').select('*');
}

export function findRoomType(name, trx = db) {
  return trx('room_types').where({ name }).first();
}

export function findRoomTypeIgnoreCase(name, trx = db) {
  return trx('room_types').whereRaw('LOWER(name) = ?', [name.toLowerCase()]).first('id');
}

export function roomTypeNames(trx = db) {
  return trx('room_types').select('id', 'name');
}

/** The room type with this name, created when it does not exist yet. */
export async function findOrCreateRoomType(name, trx = db) {
  const type = await trx('room_types').where({ name }).first();
  if (type) return type;
  const [id] = await trx('room_types').insert({ name });
  return { id, name };
}

export function insertRoomTypeIfMissing(name, trx) {
  return trx('room_types').insert({ name }).onConflict('name').ignore();
}

export async function roomTypeIdsByName(trx = db) {
  return new Map((await trx('room_types').select('id', 'name')).map((t) => [t.name, t.id]));
}

/** Deletes room types not in the list that no room uses any more. */
export function deleteUnusedRoomTypesExcept(names, trx) {
  return trx('room_types').whereNotIn('name', names.length ? names : ['']).whereNotExists(trx('rooms').whereRaw('rooms.room_type_id = room_types.id')).del();
}
