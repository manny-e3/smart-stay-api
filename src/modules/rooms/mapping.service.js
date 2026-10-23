import crypto from 'node:crypto';
import { db, json } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { sha256 } from '../../core/auth.js';
import { badRequest, notFound } from '../../core/errors.js';
import { bus, EVENTS } from '../../core/events.js';
import { VENDORS } from '../../adapters/index.js';
import { getSettings } from '../settings/settings.service.js';

const publicAdapter = (a) => ({
  id: a.id,
  name: a.name,
  vendor: a.vendor,
  isEnabled: Boolean(a.is_enabled),
  config: redact(a.config),
  hasWebhookSecret: Boolean(a.webhook_secret_hash),
  health: {
    status: a.status,
    consecutiveFailures: a.consecutive_failures,
    lastSuccessAt: a.last_success_at,
    lastErrorAt: a.last_error_at,
    lastError: a.last_error,
    latencyMs: a.latency_ms,
  },
});

/** Hides credentials in adapter config when sending it to the dashboard. */
function redact(config) {
  if (!config) return {};
  return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, /key|secret|token|password/i.test(k) ? '********' : v]));
}

export async function getMapping() {
  const [floors, roomTypes, rooms, devices, adapters] = await Promise.all([
    db('floors').orderBy('number'),
    db('room_types').orderBy('name'),
    db('rooms as r').join('floors as f', 'f.id', 'r.floor_id').leftJoin('room_types as t', 't.id', 'r.room_type_id').select('r.*', 'f.number as floor_number', 't.name as type_name'),
    db('devices as d').join('adapters as a', 'a.id', 'd.adapter_id').where('d.is_active', true).select('d.*', 'a.name as adapter_name'),
    db('adapters').orderBy('name'),
  ]);
  const devicesByRoom = new Map();
  for (const d of devices) {
    const list = devicesByRoom.get(d.room_id) || [];
    list.push({ id: d.id, adapter: d.adapter_name, externalId: d.external_id, type: d.type, name: d.name, capabilities: d.capabilities ?? null });
    devicesByRoom.set(d.room_id, list);
  }
  return {
    floors: floors.map((f) => ({ id: f.id, number: f.number, name: f.name })),
    roomTypes: roomTypes.map((t) => t.name),
    adapters: adapters.map(publicAdapter),
    rooms: rooms
      .sort((a, b) => a.floor_number - b.floor_number || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }))
      .map((r) => ({ id: r.id, number: r.number, floor: r.floor_number, roomType: r.type_name, isActive: Boolean(r.is_active), devices: devicesByRoom.get(r.id) || [] })),
    unassignedDevices: devicesByRoom.get(null) || [],
  };
}

/**
 * Replaces the whole room/floor/device mapping in one transaction.
 * Rooms and devices left out are deactivated (never deleted, so history stays intact).
 */
export async function putMapping(input, actor) {
  const { floors = [], roomTypes = [], adapters = [], rooms = [] } = input;

  const dup = (list, key) => list.map(key).find((v, i, arr) => arr.indexOf(v) !== i);
  const errs = [];
  if (dup(floors, (f) => f.number) !== undefined) errs.push('Duplicate floor number');
  if (dup(rooms, (r) => r.number)) errs.push(`Duplicate room number ${dup(rooms, (r) => r.number)}`);
  if (dup(adapters, (a) => a.name)) errs.push(`Duplicate adapter ${dup(adapters, (a) => a.name)}`);
  const allDevices = rooms.flatMap((r) => (r.devices || []).map((d) => ({ ...d, room: r.number })));
  const dupDevice = dup(allDevices, (d) => `${d.adapter}|${d.externalId}`);
  if (dupDevice) errs.push(`Device ${dupDevice.replace('|', ' / ')} is mapped to more than one room`);
  for (const a of adapters) if (!VENDORS[a.vendor]) errs.push(`Unknown adapter vendor "${a.vendor}"`);
  const floorNumbers = new Set(floors.map((f) => f.number));
  for (const r of rooms) if (!floorNumbers.has(r.floor)) errs.push(`Room ${r.number} uses floor ${r.floor} which is not in the floors list`);
  const typeNames = new Set(roomTypes);
  for (const r of rooms) if (r.roomType && !typeNames.has(r.roomType)) errs.push(`Room ${r.number} uses room type "${r.roomType}" which is not in the roomTypes list`);
  if (errs.length) throw badRequest('Mapping is not valid', errs.map((message) => ({ field: 'body', message })));

  const result = await db.transaction(async (trx) => {
    // Floors and room types
    for (const f of floors) await trx('floors').insert({ number: f.number, name: f.name ?? null }).onConflict('number').merge(['name']);
    for (const name of roomTypes) await trx('room_types').insert({ name }).onConflict('name').ignore();
    const floorId = new Map((await trx('floors').select('id', 'number')).map((f) => [f.number, f.id]));
    const typeId = new Map((await trx('room_types').select('id', 'name')).map((t) => [t.name, t.id]));

    // Adapters: listed ones are upserted; others keep existing but are kept as-is unless referenced
    for (const a of adapters) {
      const row = { name: a.name, vendor: a.vendor, is_enabled: a.isEnabled ?? true };
      if (a.config) {
        // The dashboard receives masked credentials; keep the stored value when a mask comes back.
        const existing = (await trx('adapters').where({ name: a.name }).first('config'))?.config || {};
        const merged = Object.fromEntries(Object.entries(a.config).map(([k, v]) => [k, v === '********' ? existing[k] : v]));
        row.config = json(merged);
      }
      await trx('adapters').insert(row).onConflict('name').merge(Object.keys(row).filter((k) => k !== 'name'));
    }
    const adapterId = new Map((await trx('adapters').select('id', 'name')).map((a) => [a.name, a.id]));
    const missingAdapter = allDevices.find((d) => !adapterId.has(d.adapter));
    if (missingAdapter) throw badRequest(`Device ${missingAdapter.externalId} uses unknown adapter "${missingAdapter.adapter}"`);

    // Rooms
    for (const r of rooms) {
      await trx('rooms')
        .insert({ number: r.number, floor_id: floorId.get(r.floor), room_type_id: r.roomType ? typeId.get(r.roomType) : null, is_active: r.isActive ?? true })
        .onConflict('number')
        .merge(['floor_id', 'room_type_id', 'is_active']);
    }
    const listedRooms = rooms.map((r) => r.number);
    const deactivatedRooms = await trx('rooms').whereNotIn('number', listedRooms.length ? listedRooms : ['']).where('is_active', true).update({ is_active: false });
    const roomId = new Map((await trx('rooms').select('id', 'number')).map((r) => [r.number, r.id]));

    // Devices
    const keep = [];
    for (const d of allDevices) {
      const aId = adapterId.get(d.adapter);
      await trx('devices')
        .insert({ adapter_id: aId, external_id: d.externalId, room_id: roomId.get(d.room), type: d.type, name: d.name ?? null, is_active: true, capabilities: d.capabilities ? json(d.capabilities) : null })
        .onConflict(['adapter_id', 'external_id'])
        .merge(['room_id', 'type', 'name', 'is_active', ...(d.capabilities !== undefined ? ['capabilities'] : [])]);
      keep.push(`${aId}|${d.externalId}`);
    }
    const active = await trx('devices').where('is_active', true).select('id', 'adapter_id', 'external_id');
    const removeIds = active.filter((d) => !keep.includes(`${d.adapter_id}|${d.external_id}`)).map((d) => d.id);
    if (removeIds.length) await trx('devices').whereIn('id', removeIds).update({ is_active: false, room_id: null });

    // Remove floors and room types that nothing uses any more
    const listedFloors = floors.map((f) => f.number);
    await trx('floors').whereNotIn('number', listedFloors.length ? listedFloors : [-99999]).whereNotExists(trx('rooms').whereRaw('rooms.floor_id = floors.id')).del();
    await trx('room_types').whereNotIn('name', roomTypes.length ? roomTypes : ['']).whereNotExists(trx('rooms').whereRaw('rooms.room_type_id = room_types.id')).del();

    const summary = { floors: floors.length, rooms: rooms.length, devices: allDevices.length, roomsDeactivated: deactivatedRooms, devicesDeactivated: removeIds.length };
    await audit({ actor: { type: 'staff', id: actor.id }, action: 'mapping.update', entityType: 'mapping', details: summary, ip: actor.ip }, trx);
    return summary;
  });

  const { phones_per_room: phones } = await getSettings();
  const warnings = rooms
    .filter((r) => (r.devices || []).filter((d) => d.type === 'phone').length > phones)
    .map((r) => `Room ${r.number} has more phones than the ${phones} allowed in hotel settings`);

  bus.publish(EVENTS.BOARD_CHANGED, {});
  return { summary: result, warnings, mapping: await getMapping() };
}

/** Creates a new webhook secret for an adapter. The plain secret is only returned once. */
export async function rotateWebhookSecret(adapterId, actor) {
  const adapter = await db('adapters').where({ id: adapterId }).first();
  if (!adapter) throw notFound('Adapter');
  const secret = crypto.randomBytes(32).toString('base64url');
  await db('adapters').where({ id: adapterId }).update({ webhook_secret_hash: sha256(secret) });
  await audit({ actor: { type: 'staff', id: actor.id }, action: 'adapter.secret_rotated', entityType: 'adapter', entityId: adapterId, ip: actor.ip });
  return { adapterId, webhookSecret: secret, webhookUrl: `/integrations/adapters/${adapterId}/events` };
}

export async function listAdapters() {
  return (await db('adapters').orderBy('name')).map(publicAdapter);
}
