import { db, json } from '../config/db.js';

/** Tables: devices, device_states (latest state), device_events (history), adapters (vendor connections). */

/* ---- devices ----------------------------------------------------------------- */

export function findById(id, trx = db) {
  return trx('devices').where({ id }).first();
}

/** An active device by id, or by adapter + vendor device id. */
export function findActive({ deviceId, adapterId, externalId }) {
  const q = db('devices').where({ is_active: true });
  if (deviceId) q.where({ id: deviceId });
  else q.where({ adapter_id: adapterId, external_id: externalId });
  return q.first();
}

export function listActiveForAdapter(adapterId) {
  return db('devices').where({ adapter_id: adapterId, is_active: true });
}

/** Active metered devices of an adapter that belong to a room. */
export function listMetersForAdapter(adapterId) {
  return db('devices').where({ adapter_id: adapterId, is_active: true, type: 'meter' }).whereNotNull('room_id');
}

/** The active device of a type in the room with this number (device-event script). */
export function findActiveInRoomByNumber(roomNumber, type) {
  return db('devices as d').join('rooms as r', 'r.id', 'd.room_id').where({ 'r.number': roomNumber, 'd.type': type, 'd.is_active': true }).first('d.*');
}

/** Meters by vendor device id, for CSV energy imports. */
export function listMeters() {
  return db('devices').where({ type: 'meter' }).select('id', 'external_id');
}

/**
 * Devices joined with their adapter and latest state, for sending commands.
 * "config", "state" and "capabilities" keep their names so their JSON columns are parsed.
 */
export function withAdapterAndState() {
  return db('devices as d')
    .join('adapters as a', 'a.id', 'd.adapter_id')
    .leftJoin('device_states as s', 's.device_id', 'd.id')
    .where({ 'd.is_active': true, 'a.is_enabled': true })
    .select('d.*', 's.state', 's.online', 's.last_seen_at', 'a.id as a_id', 'a.name as a_name', 'a.vendor as a_vendor', 'a.config', 'a.updated_at as a_updated_at');
}

/** Guest-controllable devices in a room (lights first, then AC, curtains, TV, speaker), with adapter and state. */
export function listGuestDevicesInRoom(roomId, types) {
  return withAdapterAndState().where('d.room_id', roomId).whereIn('d.type', types).orderByRaw("FIELD(d.type, 'light', 'thermostat', 'curtain', 'tv', 'speaker')").orderBy('d.name');
}

/** Devices of the given types in one room, with adapter and state. */
export function inRoomOfTypes(roomId, types) {
  return withAdapterAndState().where('d.room_id', roomId).whereIn('d.type', types);
}

/** One device in a room, of one of the given types, with adapter and state (guest commands). */
export function findInRoomOfTypes(deviceId, roomId, types) {
  return withAdapterAndState().where({ 'd.id': deviceId, 'd.room_id': roomId }).whereIn('d.type', types).first();
}

/** One device with adapter and state. */
export function findWithAdapterAndState(id) {
  return withAdapterAndState().where('d.id', id).first();
}

/** One device with its latest state, for guest live updates. */
export function findWithState(id) {
  return db('devices as d').leftJoin('device_states as s', 's.device_id', 'd.id').where('d.id', id).first('d.*', 's.state', 's.online', 's.last_seen_at');
}

/** Lock devices with their adapter, for digital keys. */
export function locksWithAdapter() {
  return db('devices as d')
    .join('adapters as a', 'a.id', 'd.adapter_id')
    .where({ 'd.type': 'lock', 'd.is_active': true, 'a.is_enabled': true })
    .select('d.*', 'a.id as a_id', 'a.name as a_name', 'a.vendor as a_vendor', 'a.config', 'a.updated_at as a_updated_at');
}

/** Presence sensor states in rooms. */
export function presenceSensorStates(roomIds) {
  return db('devices as d')
    .join('device_states as s', 's.device_id', 'd.id')
    .whereIn('d.room_id', roomIds)
    .where({ 'd.is_active': true, 'd.type': 'sensor' })
    .select('d.room_id', 's.state');
}

/** Devices of the given types in rooms, with adapter and state, for rules. */
export function inRoomsOfTypes(roomIds, types) {
  return db('devices as d')
    .join('adapters as a', 'a.id', 'd.adapter_id')
    .leftJoin('device_states as s', 's.device_id', 'd.id')
    .whereIn('d.room_id', roomIds)
    .where({ 'd.is_active': true, 'a.is_enabled': true })
    .whereIn('d.type', types)
    .select('d.*', 's.state', 'a.id as a_id', 'a.name as a_name', 'a.vendor', 'a.config', 'a.updated_at as a_updated_at');
}

/** Offline devices per room. */
export function offlineCountsByRoom(roomIds) {
  return db('device_states as ds')
    .join('devices as d', 'd.id', 'ds.device_id')
    .whereIn('d.room_id', roomIds)
    .where({ 'd.is_active': true, 'ds.online': false })
    .groupBy('d.room_id')
    .select('d.room_id')
    .count({ n: '*' });
}

/** Active devices in a room with adapter name, adapter health and state (room detail panel). */
export function detailForRoom(roomId) {
  return db('devices as d')
    .join('adapters as ad', 'ad.id', 'd.adapter_id')
    .leftJoin('device_states as ds', 'ds.device_id', 'd.id')
    .where({ 'd.room_id': roomId, 'd.is_active': true })
    .orderBy(['d.type', 'd.name'])
    .select('d.id', 'd.type', 'd.name', 'd.external_id', 'ad.name as adapter_name', 'ad.status as adapter_status', 'ds.online', 'ds.state', 'ds.last_seen_at');
}

/** Every device in a room (active or not), for the room devices screen. */
export function listForRoomManagement(roomId) {
  return db('devices as d')
    .leftJoin('adapters as a', 'a.id', 'd.adapter_id')
    .leftJoin('device_states as ds', 'ds.device_id', 'd.id')
    .where({ 'd.room_id': roomId })
    .orderBy(['d.type', 'd.name'])
    .select('d.id', 'd.type', 'd.name', 'd.external_id', 'd.capabilities', 'd.is_active as isActive', 'a.name as adapter', 'ds.online', 'ds.state', 'ds.last_seen_at as lastSeenAt');
}

/** Active devices in a room with adapter name and state, returned after a room edit. */
export function activeInRoomBrief(roomId, trx = db) {
  return trx('devices as d')
    .leftJoin('adapters as a', 'a.id', 'd.adapter_id')
    .leftJoin('device_states as ds', 'ds.device_id', 'd.id')
    .where({ 'd.room_id': roomId, 'd.is_active': true })
    .select('d.id', 'd.type', 'd.name', 'd.external_id', 'a.name as adapter', 'ds.online', 'ds.state');
}

export function listInRoom(roomId, trx = db) {
  return trx('devices').where({ room_id: roomId });
}

export function findInRoom(deviceId, roomId) {
  return db('devices').where({ id: deviceId, room_id: roomId }).first();
}

export function findByAdapterAndExternalId(adapterId, externalId, trx = db) {
  return trx('devices').where({ adapter_id: adapterId, external_id: externalId }).first();
}

/** Active devices with their adapter name (mapping screen). */
export function listActiveWithAdapterName() {
  return db('devices as d').join('adapters as a', 'a.id', 'd.adapter_id').where('d.is_active', true).select('d.*', 'a.name as adapter_name');
}

/** capabilities is a JSON column: objects are stored as text. */
function withJson(fields) {
  const c = fields.capabilities;
  return c && typeof c === 'object' ? { ...fields, capabilities: json(c) } : fields;
}

export async function create(fields, trx = db) {
  const [id] = await trx('devices').insert(withJson(fields));
  return id;
}

/** Creates a device, or updates the one with the same adapter and vendor id. mergeColumns: what to overwrite (all when omitted). */
export function upsertByAdapterAndExternalId(fields, mergeColumns, trx = db) {
  const q = trx('devices').insert(withJson(fields)).onConflict(['adapter_id', 'external_id']);
  return mergeColumns ? q.merge(mergeColumns) : q.merge();
}

export function update(id, fields, trx = db) {
  return trx('devices').where({ id }).update(withJson(fields));
}

export function updateMany(ids, fields, trx = db) {
  return trx('devices').whereIn('id', ids).update(withJson(fields));
}

/** Unlinks and deactivates every device in a room. */
export function unassignAllInRoom(roomId, trx = db) {
  return trx('devices').where({ room_id: roomId }).update({ room_id: null, is_active: false });
}

export function listActiveIdentities(trx = db) {
  return trx('devices').where('is_active', true).select('id', 'adapter_id', 'external_id');
}

/** Starting state for a new device: AC on cool 22, locks locked, everything else off. */
export function insertDefaultState(deviceId, type, trx = db) {
  const state = type === 'thermostat' ? { mode: 'cool', setpoint: 22 } : type === 'lock' ? { locked: true } : { on: false };
  return trx('device_states').insert({ device_id: deviceId, online: true, state: json(state), last_seen_at: new Date() }).onConflict('device_id').ignore();
}

/* ---- device_states ------------------------------------------------------------ */

export function findState(deviceId, trx = db) {
  return trx('device_states').where({ device_id: deviceId }).first();
}

export function lockState(deviceId, trx) {
  return trx('device_states').where({ device_id: deviceId }).forUpdate().first();
}

export function listStates(deviceIds) {
  return db('device_states').whereIn('device_id', deviceIds);
}

export function insertState({ deviceId, online, state, lastSeenAt }, trx = db) {
  return trx('device_states').insert({ device_id: deviceId, online, state: json(state), last_seen_at: lastSeenAt });
}

export function updateState(deviceId, fields, trx = db) {
  const patch = { ...fields };
  if (patch.state !== undefined) patch.state = json(patch.state);
  return trx('device_states').where({ device_id: deviceId }).update(patch);
}

/* ---- device_events ------------------------------------------------------------ */

export async function insertEvent({ deviceId, type, payload, occurredAt }, trx = db) {
  const [id] = await trx('device_events').insert({ device_id: deviceId, event_type: type, payload: json(payload), occurred_at: occurredAt });
  return id;
}

export function recentEvents(deviceId, limit = 100) {
  return db('device_events').where({ device_id: deviceId }).orderBy('occurred_at', 'desc').limit(limit).select('id', 'event_type as type', 'payload', 'occurred_at as occurredAt');
}

/* ---- adapters ----------------------------------------------------------------- */

export function findAdapter(id) {
  return db('adapters').where({ id }).first();
}

export function findEnabledAdapter(id) {
  return db('adapters').where({ id, is_enabled: true }).first();
}

export function listEnabledAdapters() {
  return db('adapters').where({ is_enabled: true });
}

/** Enabled adapters that aren't marked down (the poll job skips those). */
export function listPollableAdapters() {
  return db('adapters').where({ is_enabled: true }).whereNot({ status: 'down' });
}

export function listAdapters() {
  return db('adapters').orderBy('name');
}

export function updateAdapter(id, fields, trx = db) {
  return trx('adapters').where({ id }).update(fields);
}

/** The first enabled adapter (devices added by hand are attached to it). */
export function firstEnabledAdapter(trx = db) {
  return trx('adapters').where({ is_enabled: true }).first('id');
}

export function findAdapterConfigByName(name, trx = db) {
  return trx('adapters').where({ name }).first('config');
}

/** Creates or updates an adapter by its name. */
export function upsertAdapterByName(row, trx) {
  const fields = { ...row, ...(row.config !== undefined ? { config: json(row.config) } : {}) };
  return trx('adapters').insert(fields).onConflict('name').merge(Object.keys(fields).filter((k) => k !== 'name'));
}

export async function adapterIdsByName(trx = db) {
  return new Map((await trx('adapters').select('id', 'name')).map((a) => [a.name, a.id]));
}
