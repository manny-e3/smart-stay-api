import { transaction } from '../config/db.js';
import * as Alert from '../models/alert.model.js';
import * as Device from '../models/device.model.js';
import { recordAudit } from './audit.service.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { badRequest, notFound } from '../utils/errors.js';
import { notifyStaff } from './notification.service.js';

/** Alerts: device faults, offline devices, guest issues and system problems. */

export const ALERT_TYPES = [
  'device_offline', 'device_fault', 'low_battery', 'adapter_down', 'guest_issue', 'command_failed',
  'key_failed', 'key_revoke_failed', 'pms_sync_failed',
];

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

export const toAlert = (a) => ({
  id: a.id,
  type: a.type,
  severity: a.severity,
  source: a.source,
  status: a.status,
  title: a.title,
  message: a.message,
  occurrenceCount: a.occurrence_count,
  firstSeenAt: a.first_seen_at,
  lastSeenAt: a.last_seen_at,
  room: a.room_id ? { id: a.room_id, number: a.room_number, floor: a.floor_number } : null,
  device: a.device_id ? { id: a.device_id, name: a.device_name, type: a.device_type, externalId: a.device_external_id } : null,
  adapter: a.adapter_id ? { id: a.adapter_id, name: a.adapter_name } : null,
  feedbackId: a.feedback_id,
  resolvedAt: a.resolved_at,
  resolvedBy: a.resolved_by ? { id: a.resolved_by, name: a.resolved_by_name } : null,
  resolutionNote: a.resolution_note,
});

async function loadAlert(id) {
  const a = await Alert.findWithDetails(id);
  return a ? toAlert(a) : null;
}

/** Retries a transaction when MySQL picks it as a deadlock victim (two identical alerts at once). */
async function withDeadlockRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(err.code)) throw err;
    }
  }
}

/**
 * Raises an alert, or groups it into the matching open alert (same type, room, device and adapter).
 * Repeats bump the count and last-seen time instead of adding a new alert.
 */
export async function raiseAlert({ type, severity = 'warning', source, title, message = null, roomId = null, deviceId = null, adapterId = null, feedbackId = null, deviceEventId = null, payload = null, occurredAt = new Date() }) {
  const dedupeKey = [type, roomId ?? '-', deviceId ?? '-', adapterId ?? '-', feedbackId ?? '-'].join(':');

  const { alertId, created } = await withDeadlockRetry(() =>
    transaction(async (trx) => {
      const open = await Alert.lockOpenByDedupeKey(dedupeKey, trx);
      if (open) {
        const patch = { occurrence_count: open.occurrence_count + 1, last_seen_at: occurredAt };
        if (SEVERITY_RANK[severity] > SEVERITY_RANK[open.severity]) patch.severity = severity;
        if (message) patch.message = message;
        await Alert.update(open.id, patch, trx);
        await Alert.addOccurrence({ alertId: open.id, deviceEventId, payload, occurredAt }, trx);
        return { alertId: open.id, created: false };
      }
      const id = await Alert.create(
        {
          type, severity, source, title, message, room_id: roomId, device_id: deviceId, adapter_id: adapterId, feedback_id: feedbackId,
          dedupe_key: dedupeKey, first_seen_at: occurredAt, last_seen_at: occurredAt,
        },
        trx,
      );
      await Alert.addOccurrence({ alertId: id, deviceEventId, payload, occurredAt }, trx);
      return { alertId: id, created: true };
    }),
  );

  const alert = await loadAlert(alertId);
  bus.publish(created ? EVENTS.ALERT_CREATED : EVENTS.ALERT_UPDATED, alert);
  if (roomId) bus.publish(EVENTS.ROOM_CHANGED, { roomId });

  if (created) {
    const where = alert.room ? `Room ${alert.room.number}` : alert.adapter ? `Adapter ${alert.adapter.name}` : 'Hotel';
    await notifyStaff({
      permission: 'alerts:read',
      title: `${severity === 'critical' ? 'Critical alert' : 'Alert'}: ${title}`,
      body: `${where}${message ? ` - ${message}` : ''}`,
      data: { type: 'alert', alertId, roomId },
      email: severity !== 'info',
    });
  }
  return { alert, created };
}

/** Guest-reported issue from the guest app; shows in the alert list with source "guest". */
export function reportGuestIssue({ roomId, guestId = null, stayId = null, category = 'other', description }) {
  return raiseAlert({
    type: 'guest_issue',
    severity: 'warning',
    source: 'guest',
    title: `Guest reported ${category.replace(/_/g, ' ')} issue`,
    message: description,
    roomId,
    payload: { guestId, stayId, category, description },
  });
}

export async function listAlerts(filters) {
  const result = await Alert.list(filters);
  const counts = await Alert.countOpenBySeverity();
  return {
    ...result,
    items: result.items.map(toAlert),
    openCounts: Object.fromEntries(['critical', 'warning', 'info'].map((s) => [s, Number(counts.find((c) => c.severity === s)?.n ?? 0)])),
  };
}

export async function getAlert(id) {
  const alert = await loadAlert(id);
  if (!alert) throw notFound('Alert');
  const occurrences = await Alert.recentOccurrences(id);
  const deviceHistory = alert.device ? await Device.recentEvents(alert.device.id) : [];
  const deviceState = alert.device ? await Device.findState(alert.device.id) : null;
  return {
    ...alert,
    occurrences,
    deviceHistory,
    deviceState: deviceState ? { online: deviceState.online, state: deviceState.state, lastSeenAt: deviceState.last_seen_at } : null,
  };
}

/** Resolving always needs a note explaining what was done. */
export async function resolveAlert(id, { note }, actor) {
  if (!note || note.trim().length < 3) throw badRequest('A resolution note is required');
  await transaction(async (trx) => {
    const alert = await Alert.lockById(id, trx);
    if (!alert) throw notFound('Alert');
    if (alert.status === 'resolved') throw badRequest('Alert is already resolved');
    await Alert.update(id, { status: 'resolved', resolved_at: new Date(), resolved_by: actor.id, resolution_note: note.trim() }, trx);
    await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'alert.resolve', entityType: 'alert', entityId: id, roomId: alert.room_id, details: { note: note.trim(), type: alert.type }, ip: actor.ip }, trx);
  });
  const alert = await loadAlert(id);
  bus.publish(EVENTS.ALERT_UPDATED, alert);
  if (alert.room) bus.publish(EVENTS.ROOM_CHANGED, { roomId: alert.room.id });
  return alert;
}
