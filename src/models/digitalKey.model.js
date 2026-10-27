import { db } from '../config/db.js';

/** Table: digital_keys (one mobile key per lock per stay). */

export async function create(fields) {
  const [id] = await db('digital_keys').insert(fields);
  return id;
}

export function findById(id) {
  return db('digital_keys').where({ id }).first();
}

export function update(id, fields) {
  return db('digital_keys').where({ id }).update(fields);
}

export function listForStay(stayId) {
  return db('digital_keys').where({ stay_id: stayId }).orderBy('id');
}

export function listActiveForStay(stayId) {
  return db('digital_keys').where({ stay_id: stayId, status: 'active' });
}

/** Keys that still need revoking (active, or a revoke that failed), optionally only in one room. */
export function listRevocable(stayId, roomId) {
  const q = db('digital_keys').where({ stay_id: stayId }).whereIn('status', ['active', 'revoke_failed']);
  if (roomId) q.where({ room_id: roomId });
  return q;
}

export function listRevokeFailed() {
  return db('digital_keys').where({ status: 'revoke_failed' });
}

/** Active keys of a stay in a room, valid right now, with door name and adapter. */
export function listUsable(stayId, roomId, now = new Date()) {
  return db('digital_keys as k')
    .join('devices as d', 'd.id', 'k.device_id')
    .join('adapters as a', 'a.id', 'd.adapter_id')
    .where({ 'k.stay_id': stayId, 'k.room_id': roomId, 'k.status': 'active' })
    .where('k.valid_from', '<=', now)
    .where('k.valid_until', '>', now)
    .select('k.*', 'd.name as door_name', 'd.external_id', 'd.type', 'a.id as a_id', 'a.name as a_name', 'a.vendor as a_vendor', 'a.config', 'a.updated_at as a_updated_at');
}

/** A key by the vendor's key id on the lock with this vendor device id (mock lock after a restart). */
export function findByExternalIdOnLock(externalKeyId, lockExternalId) {
  return db('digital_keys as k').join('devices as d', 'd.id', 'k.device_id').where({ 'k.external_key_id': externalKeyId, 'd.external_id': lockExternalId }).first('k.*');
}

/** The newest active key of a stay in a room (optionally for one lock). */
export function findActiveForDoor(stayId, roomId, deviceId) {
  const q = db('digital_keys').where({ stay_id: stayId, room_id: roomId, status: 'active' });
  if (deviceId) q.where({ device_id: deviceId });
  return q.orderBy('id', 'desc').first();
}
