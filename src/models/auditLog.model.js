import { db, paginate, json } from '../config/db.js';

/** Table: audit_log. Append-only: rows are never updated or deleted. */

export function insert({ actorType, staffId = null, guestId = null, action, entityType, entityId = null, roomId = null, details = null, ip = null }, trx = db) {
  return trx('audit_log').insert({
    actor_type: actorType,
    staff_id: staffId,
    guest_id: guestId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    room_id: roomId,
    details: json(details),
    ip,
  });
}

/**
 * Search with filters. `action` matches exactly ("room.unlock"), or as a prefix when it
 * ends with a dot ("request." finds every request action).
 */
export function search(f) {
  const q = db('audit_log as a')
    .leftJoin('staff as s', 's.id', 'a.staff_id')
    .leftJoin('rooms as r', 'r.id', 'a.room_id')
    .leftJoin('guests as g', 'g.id', 'a.guest_id')
    .select('a.*', 's.name as staff_name', 's.email as staff_email', 'r.number as room_number', 'g.first_name as guest_first_name', 'g.last_name as guest_last_name')
    .orderBy('a.created_at', 'desc')
    .orderBy('a.id', 'desc');
  if (f.staffId) q.where('a.staff_id', f.staffId);
  if (f.actorType) q.where('a.actor_type', f.actorType);
  if (f.action) f.action.endsWith('.') ? q.where('a.action', 'like', `${f.action}%`) : q.where('a.action', f.action);
  if (f.entityType) q.where('a.entity_type', f.entityType);
  if (f.entityId) q.where('a.entity_id', f.entityId);
  if (f.roomId) q.where('a.room_id', f.roomId);
  if (f.roomNumber) q.where('r.number', f.roomNumber);
  if (f.from) q.where('a.created_at', '>=', f.from);
  if (f.to) q.where('a.created_at', '<=', f.to);
  if (f.q) {
    q.where((w) =>
      w
        .whereILike('a.action', `%${f.q}%`)
        .orWhereILike('s.name', `%${f.q}%`)
        .orWhereILike('s.email', `%${f.q}%`)
        .orWhereRaw('CAST(a.details AS CHAR) LIKE ?', [`%${f.q}%`]),
    );
  }
  return paginate(q, f);
}
