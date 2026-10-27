import * as AuditLog from '../models/auditLog.model.js';

/**
 * Writes one audit entry. Call it inside the same transaction as the change it records.
 * actor: { type: 'staff' | 'guest' | 'system', id?: number }
 */
export function recordAudit({ actor = { type: 'system' }, action, entityType, entityId = null, roomId = null, details = null, ip = null }, trx) {
  return AuditLog.insert(
    {
      actorType: actor.type,
      staffId: actor.type === 'staff' ? actor.id : null,
      guestId: actor.type === 'guest' ? actor.id : null,
      action,
      entityType,
      entityId,
      roomId,
      details,
      ip,
    },
    trx,
  );
}

/** Older name, kept so existing callers keep working. */
export const audit = recordAudit;

const toEntry = (a) => ({
  id: a.id,
  action: a.action,
  actor:
    a.actor_type === 'staff'
      ? { type: 'staff', id: a.staff_id, name: a.staff_name, email: a.staff_email }
      : a.actor_type === 'guest'
        ? { type: 'guest', id: a.guest_id, name: [a.guest_first_name, a.guest_last_name].filter(Boolean).join(' ') }
        : { type: 'system' },
  entityType: a.entity_type,
  entityId: a.entity_id,
  room: a.room_id ? { id: a.room_id, number: a.room_number } : null,
  details: a.details,
  ip: a.ip,
  at: a.created_at,
});

/** Audit log search for managers. */
export async function searchAudit(filters) {
  const result = await AuditLog.search(filters);
  return { ...result, items: result.items.map(toEntry) };
}
