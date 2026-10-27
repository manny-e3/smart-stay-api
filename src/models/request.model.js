import { db, paginate, json } from '../config/db.js';

/** Tables: requests (guest service requests), request_events (their history). */

const COLUMNS = [
  'q.*',
  'r.number as room_number',
  'f.number as floor_number',
  'st.name as assignee_name',
  'cb.name as created_by_name',
  'g.first_name as guest_first_name',
  'g.last_name as guest_last_name',
];

const withDetails = () =>
  db('requests as q')
    .join('rooms as r', 'r.id', 'q.room_id')
    .join('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('staff as st', 'st.id', 'q.assigned_to')
    .leftJoin('staff as cb', 'cb.id', 'q.created_by_staff_id')
    .leftJoin('guests as g', 'g.id', 'q.guest_id');

/** One request with room, assignee, creator and guest names. */
export function findWithDetails(id) {
  return withDetails().where('q.id', id).first(COLUMNS);
}

export function lockById(id, trx) {
  return trx('requests').where({ id }).forUpdate().first();
}

/** A request that belongs to the given stay, locked for the transaction. */
export function lockForStay(id, stayId, trx) {
  return trx('requests').where({ id, stay_id: stayId }).forUpdate().first();
}

/** Request queue: escalated first, then urgent, then oldest. */
export function list({ status, category, priority, roomId, assignedTo, unassigned, escalated, from, to, page, limit }) {
  const q = withDetails().select(COLUMNS);
  if (status?.length) q.whereIn('q.status', status);
  if (category?.length) q.whereIn('q.category', category);
  if (priority?.length) q.whereIn('q.priority', priority);
  if (roomId) q.where('q.room_id', roomId);
  if (assignedTo) q.where('q.assigned_to', assignedTo);
  if (unassigned) q.whereNull('q.assigned_to');
  if (escalated !== undefined) escalated ? q.whereNotNull('q.escalated_at') : q.whereNull('q.escalated_at');
  if (from) q.where('q.created_at', '>=', from);
  if (to) q.where('q.created_at', '<=', to);
  q.orderByRaw("q.escalated_at IS NULL, FIELD(q.priority, 'urgent', 'high', 'normal'), q.created_at ASC");
  return paginate(q, { page, limit });
}

export function countByStatus(statuses) {
  return db('requests').whereIn('status', statuses).select('status').count({ n: '*' }).groupBy('status');
}

export async function countOpen(statuses) {
  const row = await db('requests').whereIn('status', statuses).count({ n: '*' }).first();
  return Number(row.n);
}

export async function create(fields, trx = db) {
  const [id] = await trx('requests').insert(fields);
  return id;
}

export function update(id, fields, trx = db) {
  return trx('requests').where({ id }).update(fields);
}

export function updateMany(ids, fields, trx = db) {
  return trx('requests').whereIn('id', ids).update(fields);
}

/** Sets escalated_at only if the request is still new/assigned and not yet escalated. Returns rows changed. */
export function markEscalated(id, at, trx) {
  return trx('requests').where({ id }).whereNull('escalated_at').whereIn('status', ['new', 'assigned']).update({ escalated_at: at });
}

/** Requests waiting since before the cutoff and not yet escalated. */
export function listOverdue(cutoff) {
  return db('requests').whereIn('status', ['new', 'assigned']).whereNull('escalated_at').where('created_at', '<=', cutoff).select('id');
}

/** Open requests of a stay, except the given categories. */
export function listOpenForStay(stayId, openStatuses, exceptCategories, trx = db) {
  return trx('requests').where({ stay_id: stayId }).whereIn('status', openStatuses).whereNotIn('category', exceptCategories).select('id', 'status');
}

/** Open requests in rooms, grouped per room, with the escalated count and oldest time. */
export function openCountsByRoom(roomIds, openStatuses) {
  return db('requests')
    .whereIn('room_id', roomIds)
    .whereIn('status', openStatuses)
    .groupBy('room_id')
    .select('room_id')
    .count({ open: '*' })
    .select(db.raw('SUM(escalated_at IS NOT NULL) AS escalated'))
    .min({ oldest: 'created_at' });
}

/** Open requests in one room, oldest first, with the assignee. */
export function openForRoom(roomId, openStatuses) {
  return db('requests as q')
    .leftJoin('staff as st', 'st.id', 'q.assigned_to')
    .where('q.room_id', roomId)
    .whereIn('q.status', openStatuses)
    .orderBy('q.created_at')
    .select('q.id', 'q.category', 'q.description', 'q.priority', 'q.status', 'q.created_at', 'q.escalated_at', 'st.id as assignee_id', 'st.name as assignee_name');
}

/** All requests of a stay, newest first (stay detail page). */
export function listForStaySummary(stayId) {
  return db('requests').where({ stay_id: stayId }).orderBy('created_at', 'desc').select('id', 'category', 'status', 'room_id', 'created_at');
}

/** A guest's requests, with the room number (guest app). */
export function forStay(stayId) {
  return db('requests as q').join('rooms as r', 'r.id', 'q.room_id').where('q.stay_id', stayId).select('q.*', 'r.number as room_number');
}

/** One request with its room number, for guest live updates. */
export function findWithRoomNumber(id) {
  return db('requests as q').join('rooms as r', 'r.id', 'q.room_id').where('q.id', id).first('q.*', 'r.number as room_number');
}

export function listForGuest(guestId) {
  return db('requests').where({ guest_id: guestId });
}

/* ---- request_events ------------------------------------------------------------ */

export function addEvent({ requestId, staffId = null, actorType, action, fromStatus = null, toStatus = null, note = null, data = null }, trx = db) {
  return trx('request_events').insert({
    request_id: requestId,
    staff_id: staffId,
    actor_type: actorType,
    action,
    from_status: fromStatus,
    to_status: toStatus,
    note,
    data: json(data),
  });
}

/** History of one request, oldest first, with staff names. */
export function history(requestId) {
  return db('request_events as e')
    .leftJoin('staff as s', 's.id', 'e.staff_id')
    .where('e.request_id', requestId)
    .orderBy('e.created_at')
    .orderBy('e.id')
    .select('e.id', 'e.action', 'e.from_status', 'e.to_status', 'e.note', 'e.data', 'e.actor_type', 'e.created_at', 's.id as staff_id', 's.name as staff_name');
}

/** Raw history rows, oldest first. */
export function events(requestId) {
  return db('request_events').where({ request_id: requestId }).orderBy('created_at').orderBy('id');
}
