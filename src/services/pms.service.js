import crypto from 'node:crypto';
import { transaction } from '../config/db.js';
import * as Pms from '../models/pms.model.js';
import * as Stay from '../models/stay.model.js';
import * as Room from '../models/room.model.js';
import { recordAudit } from './audit.service.js';
import { sha256 } from '../utils/crypto.js';
import { AppError, badRequest, notFound, unauthorized } from '../utils/errors.js';
import { pmsFor, PMS_VENDORS } from '../integrations/pms/index.js';
import { raiseAlert } from './alerts.service.js';
import { eventSchema, reservationSchema, EVENT_TYPES } from '../validators/pms.validator.js';
import * as stays from './stays.service.js';

export { eventSchema, reservationSchema, EVENT_TYPES };

/**
 * PMS sync. Events arrive on the webhook (or come from reconciliation), are stored once per
 * event id, and are applied through the stay service as actor { type: 'pms' }.
 * Each event carries the whole reservation, so events that arrive out of order still work:
 * the stay is created or updated from the event, then moved to the event's status.
 */

const TARGET_STATUS = {
  'reservation.cancelled': 'cancelled',
  'reservation.no_show': 'no_show',
  'stay.checked_in': 'checked_in',
  'stay.checked_out': 'checked_out',
};

async function roomFor(code) {
  if (!code) return null;
  const room = await Room.findByPmsCodeOrNumber(code);
  if (!room) throw badRequest(`PMS room "${code}" is not mapped to a SmartStay room (set the room number or pms_code)`);
  return room;
}

/** Applies one normalised event. Returns a short result string. */
export async function applyEvent(connection, event) {
  const actor = { type: 'pms', connectionId: connection.id };
  const r = event.reservation;
  const occurredAt = event.occurredAt ?? new Date();
  let stay = await Stay.findByPmsId(connection.id, r.externalId);

  if (stay?.pms_synced_at && new Date(stay.pms_synced_at) > occurredAt) return 'ignored: older than the last applied change';

  const room = await roomFor(r.roomCode);
  const target = TARGET_STATUS[event.type] ?? r.status ?? (stay ? stay.status : 'reserved');

  if (!stay) {
    if (['checked_out', 'cancelled', 'no_show'].includes(target)) return 'ignored: unknown reservation already closed';
    const created = await stays.createStay(
      {
        guest: r.guest,
        companions: r.companions,
        roomId: room?.id,
        roomType: r.roomType && (await Room.findRoomType(r.roomType)) ? r.roomType : undefined,
        arrival: r.arrival,
        departure: r.departure,
        adults: r.adults,
        children: r.children,
        notes: r.notes,
        reference: r.reference,
        externalId: r.externalId,
      },
      actor,
    );
    stay = await Stay.findById(created.stay.id);
  } else if (['reserved', 'checked_in'].includes(stay.status)) {
    // Keep guest details and dates in line with the PMS.
    await transaction((trx) => stays.upsertGuest(trx, { ...r.guest, externalId: r.guest.externalId }, { pmsConnectionId: connection.id }));
    if (stay.status === 'reserved') {
      const patch = {};
      if (+new Date(stay.check_in_at) !== +r.arrival) patch.arrival = r.arrival;
      if (+new Date(stay.check_out_at) !== +r.departure) patch.departure = r.departure;
      if (room && room.id !== stay.room_id) patch.roomId = room.id;
      if (r.adults && r.adults !== stay.adults) patch.adults = r.adults;
      if (r.children !== undefined && r.children !== stay.children) patch.children = r.children;
      if (Object.keys(patch).length && r.departure > new Date()) await stays.updateStay(stay.id, patch, actor);
    } else if (+new Date(stay.check_out_at) !== +r.departure && r.departure > new Date()) {
      await stays.extendStay(stay.id, { departure: r.departure }, actor);
    }
    stay = await Stay.findById(stay.id);
  }

  let result = 'processed';
  if (target === 'checked_in') {
    if (stay.status === 'reserved') {
      await stays.checkIn(stay.id, { roomId: room?.id }, actor);
      result = 'checked in';
    } else if (stay.status === 'checked_in' && room && room.id !== stay.room_id) {
      await stays.moveRoom(stay.id, { roomId: room.id, reason: 'Room changed in PMS' }, actor);
      result = 'moved';
    }
  } else if (event.type === 'stay.room_moved') {
    if (stay.status === 'checked_in' && room && room.id !== stay.room_id) {
      await stays.moveRoom(stay.id, { roomId: room.id, reason: 'Room changed in PMS' }, actor);
      result = 'moved';
    } else result = 'ignored: nothing to move';
  } else if (target === 'checked_out') {
    if (stay.status === 'checked_in') {
      await stays.checkOut(stay.id, actor);
      result = 'checked out';
    } else result = `ignored: stay is ${stay.status}`;
  } else if (target === 'cancelled' || target === 'no_show') {
    if (stay.status === 'reserved') {
      await (target === 'cancelled' ? stays.cancelStay : stays.markNoShow)(stay.id, { reason: 'Updated in PMS' }, actor);
      result = target;
    } else result = `ignored: stay is ${stay.status}`;
  }

  await Stay.update(stay.id, { pms_synced_at: occurredAt });
  return result;
}

/** Checks the webhook secret header against the enabled connection. Returns the connection. */
export async function authenticateWebhook(connectionId, givenSecret) {
  const connection = await Pms.findEnabledConnection(connectionId);
  const ok = connection?.webhook_secret_hash && crypto.timingSafeEqual(Buffer.from(sha256(givenSecret || '')), Buffer.from(connection.webhook_secret_hash));
  if (!ok) throw unauthorized('Invalid PMS credentials');
  return connection;
}

/** Webhook entry point: stores each event once (by event id) and applies new ones in order. */
export async function ingestEvents(connection, events) {
  const results = [];
  const sorted = [...events].sort((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0));
  for (const event of sorted) {
    let rowId;
    try {
      rowId = await Pms.insertEvent({ connectionId: connection.id, eventId: event.eventId, type: event.type, payload: event, occurredAt: event.occurredAt });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        results.push({ eventId: event.eventId, status: 'duplicate' });
        continue;
      }
      throw err;
    }
    results.push({ eventId: event.eventId, ...(await processStored(connection, rowId, event)) });
  }
  return results;
}

async function processStored(connection, rowId, event) {
  try {
    const result = await applyEvent(connection, event);
    const status = result.startsWith('ignored') ? 'ignored' : 'processed';
    await Pms.updateEvent(rowId, { status, result, processed_at: new Date() });
    return { status, result };
  } catch (err) {
    const message = err instanceof AppError ? err.message : `Internal error: ${err.message}`;
    if (!(err instanceof AppError)) console.error('[pms] event failed:', err);
    await Pms.updateEvent(rowId, { status: 'failed', result: message.slice(0, 500), processed_at: new Date() });
    await raiseAlert({ type: 'pms_sync_failed', severity: 'warning', source: 'system', title: `PMS event could not be applied (${connection.name})`, message, payload: { eventId: event.eventId, type: event.type } });
    return { status: 'failed', result: message };
  }
}

export async function retryEvent(id) {
  const row = await Pms.findEvent(id);
  if (!row) throw notFound('PMS event');
  if (row.status !== 'failed') throw badRequest('Only failed events can be retried');
  const connection = await Pms.findConnection(row.connection_id);
  const event = eventSchema.parse(row.payload);
  return { id, ...(await processStored(connection, id, event)) };
}

/**
 * Compares in-house guests in the PMS with SmartStay and fixes differences:
 * missing check-ins are applied, guests the PMS no longer has in-house are checked out,
 * room differences become moves.
 */
export async function reconcile(connection) {
  const summary = { checkedIn: 0, checkedOut: 0, moved: 0, failed: 0 };
  let list;
  try {
    list = await pmsFor(connection).fetchInHouse();
  } catch (err) {
    await markFailure(connection, err.message);
    throw new AppError(502, `PMS could not be reached: ${err.message}`, 'PMS_UNREACHABLE');
  }
  const now = new Date();
  const seen = new Set();
  for (const raw of list) {
    const parsed = reservationSchema.safeParse(raw);
    if (!parsed.success) {
      summary.failed++;
      continue;
    }
    seen.add(parsed.data.externalId);
    try {
      const result = await applyEvent(connection, { eventId: `reconcile:${now.toISOString()}:${parsed.data.externalId}`, type: 'stay.checked_in', occurredAt: now, reservation: parsed.data });
      if (result === 'checked in') summary.checkedIn++;
      if (result === 'moved') summary.moved++;
    } catch (err) {
      summary.failed++;
      console.error('[pms] reconcile item failed:', err.message);
    }
  }
  for (const s of await Stay.listCheckedInForPms(connection.id)) {
    if (seen.has(s.external_id)) continue;
    try {
      await stays.checkOut(s.id, { type: 'pms', connectionId: connection.id }, { note: 'No longer in-house in PMS (reconciliation)' });
      await Stay.update(s.id, { pms_synced_at: now });
      summary.checkedOut++;
    } catch {
      summary.failed++;
    }
  }
  const result = `in PMS ${list.length}; checked in ${summary.checkedIn}, checked out ${summary.checkedOut}, moved ${summary.moved}, failed ${summary.failed}`;
  await Pms.updateConnection(connection.id, { last_sync_at: now, last_sync_result: result, status: summary.failed ? 'degraded' : 'healthy', consecutive_failures: 0 });
  if (summary.failed) {
    await raiseAlert({ type: 'pms_sync_failed', severity: 'warning', source: 'system', title: `PMS reconciliation had problems (${connection.name})`, message: result });
  }
  return summary;
}

async function markFailure(connection, message) {
  const failures = connection.consecutive_failures + 1;
  await Pms.updateConnection(connection.id, { status: failures >= 3 ? 'down' : 'degraded', consecutive_failures: failures, last_error_at: new Date(), last_error: message.slice(0, 500) });
  if (failures === 3) {
    await raiseAlert({ type: 'pms_sync_failed', severity: 'critical', source: 'system', title: `PMS "${connection.name}" is not responding`, message: `${message}. Check-ins and check-outs can be done manually until it recovers.` });
  }
}

/** Background job: reconciles every enabled connection. */
export async function reconcileAll() {
  const connections = await Pms.listEnabledConnections();
  for (const c of connections) {
    try {
      await reconcile(c);
    } catch (err) {
      console.error(`[pms] reconcile ${c.name} failed:`, err.message);
    }
  }
  return connections.length;
}

/* ---------------------------------------------------------- admin CRUD */

const redact = (config) => Object.fromEntries(Object.entries(config || {}).map(([k, v]) => [k, /key|secret|token|password/i.test(k) ? '********' : v]));

export const toConnection = (c) => ({
  id: c.id,
  name: c.name,
  vendor: c.vendor,
  isEnabled: Boolean(c.is_enabled),
  config: redact(c.config),
  hasWebhookSecret: Boolean(c.webhook_secret_hash),
  status: c.status,
  lastSyncAt: c.last_sync_at,
  lastSyncResult: c.last_sync_result,
  lastError: c.last_error,
  lastErrorAt: c.last_error_at,
  webhookUrl: `/integrations/pms/${c.id}/events`,
});

export async function listConnections() {
  return (await Pms.listConnections()).map(toConnection);
}

async function getConnection(id) {
  const c = await Pms.findConnection(id);
  if (!c) throw notFound('PMS connection');
  return c;
}

export async function createConnection({ name, vendor, config = {}, isEnabled = true }, actor) {
  if (!PMS_VENDORS[vendor]) throw badRequest(`Unknown PMS vendor "${vendor}"`);
  const id = await Pms.createConnection({ name, vendor, config, isEnabled });
  await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'pms.connection_create', entityType: 'pms_connection', entityId: id, details: { name, vendor }, ip: actor.ip });
  return toConnection(await getConnection(id));
}

export async function updateConnection(id, patch, actor) {
  const current = await getConnection(id);
  const update = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.isEnabled !== undefined) update.is_enabled = patch.isEnabled;
  if (patch.config !== undefined) {
    // "********" means "keep the saved value" (the UI only ever sees redacted secrets).
    const merged = Object.fromEntries(Object.entries(patch.config).map(([k, v]) => [k, v === '********' ? current.config?.[k] : v]));
    update.config = merged;
  }
  if (Object.keys(update).length) await Pms.updateConnection(id, update);
  await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'pms.connection_update', entityType: 'pms_connection', entityId: id, details: { fields: Object.keys(patch) }, ip: actor.ip });
  return toConnection(await getConnection(id));
}

export async function rotateSecret(id, actor) {
  await getConnection(id);
  const secret = crypto.randomBytes(32).toString('base64url');
  await Pms.updateConnection(id, { webhook_secret_hash: sha256(secret) });
  await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'pms.secret_rotated', entityType: 'pms_connection', entityId: id, ip: actor.ip });
  return { connectionId: id, webhookSecret: secret, webhookUrl: `/integrations/pms/${id}/events` };
}

export async function syncNow(id, actor) {
  const connection = await getConnection(id);
  const summary = await reconcile(connection);
  await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'pms.sync', entityType: 'pms_connection', entityId: id, details: summary, ip: actor.ip });
  return { summary, connection: toConnection(await getConnection(id)) };
}

export async function listEvents(filters) {
  const result = await Pms.listEvents(filters);
  return {
    ...result,
    items: result.items.map((e) => ({ id: e.id, connectionId: e.connection_id, eventId: e.external_event_id, type: e.event_type, status: e.status, result: e.result, payload: e.payload, occurredAt: e.occurred_at, receivedAt: e.received_at, processedAt: e.processed_at })),
  };
}
