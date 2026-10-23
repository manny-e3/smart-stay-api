import { db } from '../config/db.js';

/**
 * Append-only audit log. Rows are never updated or deleted.
 * actor: { type: 'staff' | 'guest' | 'system', id?: number }
 */
export async function audit(
  { actor = { type: 'system' }, action, entityType, entityId = null, roomId = null, details = null, ip = null },
  trx = db,
) {
  await trx('audit_log').insert({
    actor_type: actor.type,
    staff_id: actor.type === 'staff' ? actor.id : null,
    guest_id: actor.type === 'guest' ? actor.id : null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    room_id: roomId,
    details: details ? JSON.stringify(details) : null,
    ip,
  });
}

/** Audit helper for an authenticated staff request. */
export const auditReq = (req, entry, trx) => audit({ ...entry, actor: { type: 'staff', id: req.staff.id }, ip: req.ip }, trx);
