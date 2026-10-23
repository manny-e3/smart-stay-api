import { db, json } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { bus, EVENTS } from '../../core/events.js';
import { notFound } from '../../core/errors.js';
import { raiseAlert } from '../alerts/alerts.service.js';

/**
 * Device event pipeline. Every event from a vendor webhook or from polling goes through
 * ingestEvent: it is stored, the device state is updated, and alerts, DND changes and
 * unlock audit entries are created from it.
 *
 * Event types: status, online, offline, fault, low_battery, unlock, dnd_on, dnd_off, presence.
 */
export const DEVICE_EVENT_TYPES = ['status', 'online', 'offline', 'fault', 'low_battery', 'unlock', 'dnd_on', 'dnd_off', 'presence'];

export async function findDevice({ deviceId, adapterId, externalId }) {
  const q = db('devices').where({ is_active: true });
  if (deviceId) q.where({ id: deviceId });
  else q.where({ adapter_id: adapterId, external_id: externalId });
  return q.first();
}

async function upsertState(trx, deviceId, { online, state }, seenAt) {
  const current = await trx('device_states').where({ device_id: deviceId }).forUpdate().first();
  const nextState = state ? { ...(current?.state || {}), ...state } : current?.state || {};
  const nextOnline = online ?? current?.online ?? true;
  if (current) {
    await trx('device_states').where({ device_id: deviceId }).update({ online: nextOnline, state: json(nextState), last_seen_at: seenAt });
  } else {
    await trx('device_states').insert({ device_id: deviceId, online: nextOnline, state: json(nextState), last_seen_at: seenAt });
  }
  return { wasOnline: current ? Boolean(current.online) : true, online: nextOnline, state: nextState };
}

export async function ingestEvent(device, { type, payload = {}, occurredAt = new Date() }) {
  const at = new Date(occurredAt);
  const roomId = device.room_id;
  let stateChange;

  const eventId = await db.transaction(async (trx) => {
    const [id] = await trx('device_events').insert({ device_id: device.id, event_type: type, payload: json(payload), occurred_at: at });

    switch (type) {
      case 'status':
        stateChange = await upsertState(trx, device.id, { online: payload.online, state: payload.state }, at);
        break;
      case 'online':
        stateChange = await upsertState(trx, device.id, { online: true }, at);
        break;
      case 'offline':
        stateChange = await upsertState(trx, device.id, { online: false }, at);
        break;
      case 'presence':
        stateChange = await upsertState(trx, device.id, { state: { presence: Boolean(payload.presence), presenceChangedAt: at.toISOString() } }, at);
        break;
      case 'dnd_on':
      case 'dnd_off':
        if (roomId) await trx('rooms').where({ id: roomId }).update({ dnd: type === 'dnd_on', dnd_updated_at: at });
        break;
      case 'unlock':
        await audit(
          {
            actor: payload.guestId ? { type: 'guest', id: payload.guestId } : payload.staffId ? { type: 'staff', id: payload.staffId } : { type: 'system' },
            action: 'room.unlock',
            entityType: 'device',
            entityId: device.id,
            roomId,
            details: { method: payload.method ?? 'unknown', success: payload.success !== false },
          },
          trx,
        );
        break;
      default:
        await upsertState(trx, device.id, {}, at);
    }
    return id;
  });

  const label = device.name || `${device.type} ${device.external_id}`;
  if (type === 'fault') {
    await raiseAlert({ type: 'device_fault', severity: payload.severity === 'warning' ? 'warning' : 'critical', source: 'device', title: `${label} reported a fault`, message: payload.message || payload.code || null, roomId, deviceId: device.id, deviceEventId: eventId, payload, occurredAt: at });
  } else if (type === 'low_battery') {
    await raiseAlert({ type: 'low_battery', severity: 'warning', source: 'device', title: `${label} battery low`, message: payload.level !== undefined ? `Battery at ${payload.level}%` : null, roomId, deviceId: device.id, deviceEventId: eventId, payload, occurredAt: at });
  } else if (stateChange && stateChange.wasOnline && !stateChange.online) {
    await raiseAlert({ type: 'device_offline', severity: device.type === 'lock' ? 'critical' : 'warning', source: 'device', title: `${label} is offline`, roomId, deviceId: device.id, deviceEventId: eventId, payload, occurredAt: at });
  }

  if (stateChange) bus.publish(EVENTS.DEVICE_STATE, { deviceId: device.id, roomId, type: device.type });
  if (roomId) bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return { eventId };
}

export async function ingestForAdapter(adapterId, events) {
  const results = [];
  for (const e of events) {
    const device = await findDevice({ adapterId, externalId: e.externalId });
    if (!device) {
      results.push({ externalId: e.externalId, accepted: false, reason: 'unknown device' });
      continue;
    }
    await ingestEvent(device, e);
    results.push({ externalId: e.externalId, accepted: true });
  }
  return results;
}

/** Applies polled states, only creating events when something actually changed. */
export async function applyPolledStates(adapterRow, devices, states) {
  const byExternal = new Map(devices.map((d) => [d.external_id, d]));
  const current = await db('device_states').whereIn('device_id', devices.map((d) => d.id));
  const currentById = new Map(current.map((c) => [c.device_id, c]));
  let changed = 0;
  for (const s of states) {
    const device = byExternal.get(s.externalId);
    if (!device) continue;
    const prev = currentById.get(device.id);
    const merged = { ...(prev?.state || {}), ...(s.state || {}) };
    const same = prev && Boolean(prev.online) === Boolean(s.online ?? true) && JSON.stringify(prev.state || {}) === JSON.stringify(merged);
    if (same) {
      await db('device_states').where({ device_id: device.id }).update({ last_seen_at: new Date() });
      continue;
    }
    await ingestEvent(device, { type: 'status', payload: { online: s.online ?? true, state: s.state || {} } });
    changed++;
  }
  return changed;
}

export async function getDeviceOrThrow(id) {
  const d = await db('devices').where({ id }).first();
  if (!d) throw notFound('Device');
  return d;
}
