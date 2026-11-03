import { db, paginate, json } from '../config/db.js';

/** Tables: alerts, alert_occurrences (each time a grouped alert happened again). */

const COLUMNS = [
  'a.*',
  'r.number as room_number',
  'f.number as floor_number',
  'd.name as device_name',
  'd.type as device_type',
  'd.external_id as device_external_id',
  'ad.name as adapter_name',
  'st.name as resolved_by_name',
];

const withDetails = () =>
  db('alerts as a')
    .leftJoin('rooms as r', 'r.id', 'a.room_id')
    .leftJoin('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('devices as d', 'd.id', 'a.device_id')
    .leftJoin('adapters as ad', 'ad.id', 'a.adapter_id')
    .leftJoin('staff as st', 'st.id', 'a.resolved_by');

/** One alert with its room, device, adapter and resolver names. */
export function findWithDetails(id) {
  return withDetails().where('a.id', id).first(COLUMNS);
}

export function findById(id, trx = db) {
  return trx('alerts').where({ id }).first();
}

export function lockById(id, trx) {
  return trx('alerts').where({ id }).forUpdate().first();
}

/** The open alert with this grouping key, locked for the rest of the transaction. */
export function lockOpenByDedupeKey(dedupeKey, trx) {
  return trx('alerts').where({ dedupe_key: dedupeKey, status: 'open' }).forUpdate().first();
}

export async function create(fields, trx = db) {
  const [id] = await trx('alerts').insert(fields);
  return id;
}

export function update(id, fields, trx = db) {
  return trx('alerts').where({ id }).update(fields);
}

export function addOccurrence({ alertId, deviceEventId, payload, occurredAt }, trx = db) {
  return trx('alert_occurrences').insert({ alert_id: alertId, device_event_id: deviceEventId, payload: json(payload), occurred_at: occurredAt });
}

export function recentOccurrences(alertId, limit = 50) {
  return db('alert_occurrences').where({ alert_id: alertId }).orderBy('occurred_at', 'desc').limit(limit).select('id', 'occurred_at as occurredAt', 'payload');
}

/** Alert list: open first, then by severity, then most recent. */
export function list({ status, type, severity, source, roomId, floor, from, to, page, limit }) {
  const q = withDetails().select(COLUMNS);
  if (status) q.where('a.status', status);
  if (type?.length) q.whereIn('a.type', type);
  if (severity?.length) q.whereIn('a.severity', severity);
  if (source?.length) q.whereIn('a.source', source);
  if (roomId) q.where('a.room_id', roomId);
  if (floor !== undefined) q.where('f.number', floor);
  if (from) q.where('a.last_seen_at', '>=', from);
  if (to) q.where('a.last_seen_at', '<=', to);
  q.orderByRaw("a.status = 'open' DESC, FIELD(a.severity, 'critical', 'warning', 'info'), a.last_seen_at DESC");
  return paginate(q, { page, limit });
}

export function countOpenBySeverity() {
  return db('alerts').where({ status: 'open' }).select('severity').count({ n: '*' }).groupBy('severity');
}

export async function countOpen() {
  const row = await db('alerts').where({ status: 'open' }).count({ n: '*' }).first();
  return Number(row.n);
}

/** Open alerts in rooms, grouped per room with the highest severity. */
export function openCountsByRoom(roomIds) {
  return db('alerts')
    .whereIn('room_id', roomIds)
    .where('status', 'open')
    .groupBy('room_id')
    .select('room_id')
    .count({ open: '*' })
    .select(db.raw("MAX(FIELD(severity, 'info', 'warning', 'critical')) AS sev"));
}

/** Open alerts in one room, newest first, with device names. */
export function openForRoom(roomId) {
  return db('alerts as a')
    .leftJoin('devices as d', 'd.id', 'a.device_id')
    .where({ 'a.room_id': roomId, 'a.status': 'open' })
    .orderBy('a.last_seen_at', 'desc')
    .select('a.id', 'a.type', 'a.severity', 'a.title', 'a.message', 'a.occurrence_count', 'a.last_seen_at', 'd.name as device_name');
}

export function openCriticalTitlesForRoom(roomId) {
  return db('alerts').where({ room_id: roomId, status: 'open', severity: 'critical' }).select('title');
}
