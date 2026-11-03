import { db, json, paginate } from '../config/db.js';

/** Tables: pms_connections (hotel PMS links), pms_events (every event received, once per event id). */

/* ---- pms_connections ------------------------------------------------------------ */

export function listConnections() {
  return db('pms_connections').orderBy('name');
}

export function listEnabledConnections() {
  return db('pms_connections').where({ is_enabled: true });
}

export function findConnection(id) {
  return db('pms_connections').where({ id }).first();
}

export function findEnabledConnection(id) {
  return db('pms_connections').where({ id, is_enabled: true }).first();
}

export async function createConnection({ name, vendor, config, isEnabled }) {
  const [id] = await db('pms_connections').insert({ name, vendor, config: json(config), is_enabled: isEnabled });
  return id;
}

export function updateConnection(id, fields) {
  const patch = { ...fields };
  if (patch.config !== undefined) patch.config = json(patch.config);
  return db('pms_connections').where({ id }).update(patch);
}

/* ---- pms_events ----------------------------------------------------------------- */

/** Stores an event. Throws ER_DUP_ENTRY when this event id was already received. */
export async function insertEvent({ connectionId, eventId, type, payload, occurredAt }) {
  const [id] = await db('pms_events').insert({
    connection_id: connectionId,
    external_event_id: eventId,
    event_type: type,
    payload: json(payload),
    occurred_at: occurredAt ?? null,
  });
  return id;
}

export function findEvent(id) {
  return db('pms_events').where({ id }).first();
}

export function updateEvent(id, fields) {
  return db('pms_events').where({ id }).update(fields);
}

/** Newest first. Optional filters: connectionId, status. */
export function listEvents({ connectionId, status, page, limit }) {
  const q = db('pms_events').orderBy('received_at', 'desc').orderBy('id', 'desc');
  if (connectionId) q.where({ connection_id: connectionId });
  if (status) q.where({ status });
  return paginate(q, { page, limit });
}
