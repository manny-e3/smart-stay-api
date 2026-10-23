import { db, paginate, json } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { bus, EVENTS } from '../../core/events.js';
import { badRequest, notFound } from '../../core/errors.js';
import { notifyStaff } from '../../core/notifier.js';

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

const ALERT_COLUMNS = [
  'a.*',
  'r.number as room_number',
  'f.number as floor_number',
  'd.name as device_name',
  'd.type as device_type',
  'd.external_id as device_external_id',
  'ad.name as adapter_name',
  'st.name as resolved_by_name',
];

const baseQuery = () =>
  db('alerts as a')
    .leftJoin('rooms as r', 'r.id', 'a.room_id')
    .leftJoin('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('devices as d', 'd.id', 'a.device_id')
    .leftJoin('adapters as ad', 'ad.id', 'a.adapter_id')
    .leftJoin('staff as st', 'st.id', 'a.resolved_by');

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

const loadAlert = async (id) => {
  const a = await baseQuery().where('a.id', id).first(ALERT_COLUMNS);
  return a ? toAlert(a) : null;
};

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
 * Grouped repeats bump the count and last-seen time instead of adding a new alert.
 */
export async function raiseAlert({ type, severity = 'warning', source, title, message = null, roomId = null, deviceId = null, adapterId = null, feedbackId = null, deviceEventId = null, payload = null, occurredAt = new Date() }) {
  const dedupeKey = [type, roomId ?? '-', deviceId ?? '-', adapterId ?? '-', feedbackId ?? '-'].join(':');

  const { alertId, created } = await withDeadlockRetry(() => db.transaction(async (trx) => {
    const open = await trx('alerts').where({ dedupe_key: dedupeKey, status: 'open' }).forUpdate().first();
    if (open) {
      const patch = { occurrence_count: open.occurrence_count + 1, last_seen_at: occurredAt };
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[open.severity]) patch.severity = severity;
      if (message) patch.message = message;
      await trx('alerts').where({ id: open.id }).update(patch);
      await trx('alert_occurrences').insert({ alert_id: open.id, device_event_id: deviceEventId, payload: json(payload), occurred_at: occurredAt });
      return { alertId: open.id, created: false };
    }
    const [id] = await trx('alerts').insert({
      type, severity, source, title, message, room_id: roomId, device_id: deviceId, adapter_id: adapterId, feedback_id: feedbackId,
      dedupe_key: dedupeKey, first_seen_at: occurredAt, last_seen_at: occurredAt,
    });
    await trx('alert_occurrences').insert({ alert_id: id, device_event_id: deviceEventId, payload: json(payload), occurred_at: occurredAt });
    return { alertId: id, created: true };
  }));

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

export async function listAlerts({ status, type, severity, source, roomId, floor, from, to, page, limit }) {
  const q = baseQuery().select(ALERT_COLUMNS);
  if (status) q.where('a.status', status);
  if (type?.length) q.whereIn('a.type', type);
  if (severity?.length) q.whereIn('a.severity', severity);
  if (source?.length) q.whereIn('a.source', source);
  if (roomId) q.where('a.room_id', roomId);
  if (floor !== undefined) q.where('f.number', floor);
  if (from) q.where('a.last_seen_at', '>=', from);
  if (to) q.where('a.last_seen_at', '<=', to);
  q.orderByRaw("a.status = 'open' DESC, FIELD(a.severity, 'critical', 'warning', 'info'), a.last_seen_at DESC");
  const result = await paginate(q, { page, limit });

  const counts = await db('alerts').where({ status: 'open' }).select('severity').count({ n: '*' }).groupBy('severity');
  return {
    ...result,
    items: result.items.map(toAlert),
    openCounts: Object.fromEntries(['critical', 'warning', 'info'].map((s) => [s, Number(counts.find((c) => c.severity === s)?.n ?? 0)])),
  };
}

export async function getAlert(id) {
  const alert = await loadAlert(id);
  if (!alert) throw notFound('Alert');
  const occurrences = await db('alert_occurrences').where({ alert_id: id }).orderBy('occurred_at', 'desc').limit(50).select('id', 'occurred_at as occurredAt', 'payload');
  const deviceHistory = alert.device
    ? await db('device_events').where({ device_id: alert.device.id }).orderBy('occurred_at', 'desc').limit(100).select('id', 'event_type as type', 'payload', 'occurred_at as occurredAt')
    : [];
  const deviceState = alert.device ? await db('device_states').where({ device_id: alert.device.id }).first() : null;
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
  await db.transaction(async (trx) => {
    const alert = await trx('alerts').where({ id }).forUpdate().first();
    if (!alert) throw notFound('Alert');
    if (alert.status === 'resolved') throw badRequest('Alert is already resolved');
    await trx('alerts').where({ id }).update({ status: 'resolved', resolved_at: new Date(), resolved_by: actor.id, resolution_note: note.trim() });
    await audit({ actor: { type: 'staff', id: actor.id }, action: 'alert.resolve', entityType: 'alert', entityId: id, roomId: alert.room_id, details: { note: note.trim(), type: alert.type }, ip: actor.ip }, trx);
  });
  const alert = await loadAlert(id);
  bus.publish(EVENTS.ALERT_UPDATED, alert);
  if (alert.room) bus.publish(EVENTS.ROOM_CHANGED, { roomId: alert.room.id });
  return alert;
}
