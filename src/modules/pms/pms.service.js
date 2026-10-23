import crypto from 'node:crypto';
import { z } from 'zod';
import { db, json, paginate } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { sha256 } from '../../core/auth.js';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import { pmsFor, PMS_VENDORS } from '../../pms/index.js';
import { raiseAlert } from '../alerts/alerts.service.js';
import * as stays from '../stays/stays.service.js';

/**
 * PMS sync. Events arrive on the webhook (or come from reconciliation), are stored once per
 * event id, and are applied through the stay service as actor { type: 'pms' }.
 * Each event carries the whole reservation, so events that arrive out of order still work:
 * the stay is created or updated from the event, then moved to the event's status.
 */

const guestSchema = z.object({
  externalId: z.string().max(100).optional(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().max(80).optional(),
  email: z.email().max(190).optional(),
  phone: z.string().max(40).optional(),
  language: z.string().max(10).optional(),
});

export const reservationSchema = z.object({
  externalId: z.string().min(1).max(100),
  reference: z.string().max(20).optional(),
  status: z.enum(['reserved', 'checked_in', 'checked_out', 'cancelled', 'no_show']).optional(),
  roomCode: z.string().max(40).optional(),
  roomType: z.string().max(80).optional(),
  arrival: z.coerce.date(),
  departure: z.coerce.date(),
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  notes: z.string().max(1000).optional(),
  guest: guestSchema,
  companions: z.array(guestSchema).max(10).optional(),
});

export const EVENT_TYPES = ['reservation.upsert', 'reservation.cancelled', 'reservation.no_show', 'stay.checked_in', 'stay.checked_out', 'stay.room_moved'];

export const eventSchema = z.object({
  eventId: z.string().min(1).max(190),
  type: z.enum(EVENT_TYPES),
  occurredAt: z.coerce.date().optional(),
  reservation: reservationSchema,
});

const TARGET_STATUS = {
  'reservation.cancelled': 'cancelled',
  'reservation.no_show': 'no_show',
  'stay.checked_in': 'checked_in',
  'stay.checked_out': 'checked_out',
};

async function roomFor(code) {
  if (!code) return null;
  const room = await db('rooms').where({ pms_code: code }).orWhere({ number: code }).orderByRaw('pms_code = ? DESC', [code]).first('id', 'number', 'is_active');
  if (!room) throw badRequest(`PMS room "${code}" is not mapped to a SmartStay room (set the room number or pms_code)`);
  return room;
}

/** Applies one normalised event. Returns a short result string. */
export async function applyEvent(connection, event) {
  const actor = { type: 'pms', connectionId: connection.id };
  const r = event.reservation;
  const occurredAt = event.occurredAt ?? new Date();
  let stay = await db('stays').where({ pms_connection_id: connection.id, external_id: r.externalId }).first();

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
        roomType: r.roomType && (await db('room_types').where({ name: r.roomType }).first('id')) ? r.roomType : undefined,
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
    stay = await db('stays').where({ id: created.stay.id }).first();
  } else if (['reserved', 'checked_in'].includes(stay.status)) {
    // Keep guest details and dates in line with the PMS.
    await db.transaction((trx) => stays.upsertGuest(trx, { ...r.guest, externalId: r.guest.externalId }, { pmsConnectionId: connection.id }));
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
    stay = await db('stays').where({ id: stay.id }).first();
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

  await db('stays').where({ id: stay.id }).update({ pms_synced_at: occurredAt });
  return result;
}

/** Webhook entry point: stores each event once (by event id) and applies new ones in order. */
export async function ingestEvents(connection, events) {
  const results = [];
  const sorted = [...events].sort((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0));
  for (const event of sorted) {
    let rowId;
    try {
      [rowId] = await db('pms_events').insert({
        connection_id: connection.id,
        external_event_id: event.eventId,
        event_type: event.type,
        payload: json(event),
        occurred_at: event.occurredAt ?? null,
      });
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
    await db('pms_events').where({ id: rowId }).update({ status, result, processed_at: new Date() });
    return { status, result };
  } catch (err) {
    const message = err instanceof AppError ? err.message : `Internal error: ${err.message}`;
    if (!(err instanceof AppError)) console.error('[pms] event failed:', err);
    await db('pms_events').where({ id: rowId }).update({ status: 'failed', result: message.slice(0, 500), processed_at: new Date() });
    await raiseAlert({ type: 'pms_sync_failed', severity: 'warning', source: 'system', title: `PMS event could not be applied (${connection.name})`, message, payload: { eventId: event.eventId, type: event.type } });
    return { status: 'failed', result: message };
  }
}

export async function retryEvent(id) {
  const row = await db('pms_events').where({ id }).first();
  if (!row) throw notFound('PMS event');
  if (row.status !== 'failed') throw badRequest('Only failed events can be retried');
  const connection = await db('pms_connections').where({ id: row.connection_id }).first();
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
  const localInHouse = await db('stays').where({ pms_connection_id: connection.id, status: 'checked_in' }).select('id', 'external_id');
  for (const s of localInHouse) {
    if (seen.has(s.external_id)) continue;
    try {
      await stays.checkOut(s.id, { type: 'pms', connectionId: connection.id }, { note: 'No longer in-house in PMS (reconciliation)' });
      await db('stays').where({ id: s.id }).update({ pms_synced_at: now });
      summary.checkedOut++;
    } catch {
      summary.failed++;
    }
  }
  const result = `in PMS ${list.length}; checked in ${summary.checkedIn}, checked out ${summary.checkedOut}, moved ${summary.moved}, failed ${summary.failed}`;
  await db('pms_connections').where({ id: connection.id }).update({ last_sync_at: now, last_sync_result: result, status: summary.failed ? 'degraded' : 'healthy', consecutive_failures: 0 });
  if (summary.failed) {
    await raiseAlert({ type: 'pms_sync_failed', severity: 'warning', source: 'system', title: `PMS reconciliation had problems (${connection.name})`, message: result });
  }
  return summary;
}

async function markFailure(connection, message) {
  const failures = connection.consecutive_failures + 1;
  await db('pms_connections').where({ id: connection.id }).update({ status: failures >= 3 ? 'down' : 'degraded', consecutive_failures: failures, last_error_at: new Date(), last_error: message.slice(0, 500) });
  if (failures === 3) {
    await raiseAlert({ type: 'pms_sync_failed', severity: 'critical', source: 'system', title: `PMS "${connection.name}" is not responding`, message: `${message}. Check-ins and check-outs can be done manually until it recovers.` });
  }
}

export async function reconcileAll() {
  const connections = await db('pms_connections').where({ is_enabled: true });
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
  return (await db('pms_connections').orderBy('name')).map(toConnection);
}

async function getConnection(id) {
  const c = await db('pms_connections').where({ id }).first();
  if (!c) throw notFound('PMS connection');
  return c;
}

export async function createConnection({ name, vendor, config = {}, isEnabled = true }, actor) {
  if (!PMS_VENDORS[vendor]) throw badRequest(`Unknown PMS vendor "${vendor}"`);
  const [id] = await db('pms_connections').insert({ name, vendor, config: json(config), is_enabled: isEnabled });
  await audit({ actor: { type: 'staff', id: actor.id }, action: 'pms.connection_create', entityType: 'pms_connection', entityId: id, details: { name, vendor }, ip: actor.ip });
  return toConnection(await getConnection(id));
}

export async function updateConnection(id, patch, actor) {
  const current = await getConnection(id);
  const update = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.isEnabled !== undefined) update.is_enabled = patch.isEnabled;
  if (patch.config !== undefined) {
    const merged = Object.fromEntries(Object.entries(patch.config).map(([k, v]) => [k, v === '********' ? current.config?.[k] : v]));
    update.config = json(merged);
  }
  if (Object.keys(update).length) await db('pms_connections').where({ id }).update(update);
  await audit({ actor: { type: 'staff', id: actor.id }, action: 'pms.connection_update', entityType: 'pms_connection', entityId: id, details: { fields: Object.keys(patch) }, ip: actor.ip });
  return toConnection(await getConnection(id));
}

export async function rotateSecret(id, actor) {
  await getConnection(id);
  const secret = crypto.randomBytes(32).toString('base64url');
  await db('pms_connections').where({ id }).update({ webhook_secret_hash: sha256(secret) });
  await audit({ actor: { type: 'staff', id: actor.id }, action: 'pms.secret_rotated', entityType: 'pms_connection', entityId: id, ip: actor.ip });
  return { connectionId: id, webhookSecret: secret, webhookUrl: `/integrations/pms/${id}/events` };
}

export async function syncNow(id, actor) {
  const connection = await getConnection(id);
  const summary = await reconcile(connection);
  await audit({ actor: { type: 'staff', id: actor.id }, action: 'pms.sync', entityType: 'pms_connection', entityId: id, details: summary, ip: actor.ip });
  return { summary, connection: toConnection(await getConnection(id)) };
}

export async function listEvents({ connectionId, status, page, limit }) {
  const q = db('pms_events').orderBy('received_at', 'desc').orderBy('id', 'desc');
  if (connectionId) q.where({ connection_id: connectionId });
  if (status) q.where({ status });
  const result = await paginate(q, { page, limit });
  return {
    ...result,
    items: result.items.map((e) => ({ id: e.id, connectionId: e.connection_id, eventId: e.external_event_id, type: e.event_type, status: e.status, result: e.result, payload: e.payload, occurredAt: e.occurred_at, receivedAt: e.received_at, processedAt: e.processed_at })),
  };
}
