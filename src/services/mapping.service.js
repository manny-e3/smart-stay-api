import crypto from 'node:crypto';
import { transaction } from '../config/db.js';
import * as Room from '../models/room.model.js';
import * as Device from '../models/device.model.js';
import { recordAudit } from './audit.service.js';
import { sha256 } from '../utils/crypto.js';
import { badRequest, notFound } from '../utils/errors.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { VENDORS } from '../integrations/devices/index.js';
import { getSettings } from './settings.service.js';

/** The whole room / floor / device mapping, and device vendor connections ("adapters"). */

/** Hides credentials in adapter config before sending it to the dashboard. */
function redact(config) {
  if (!config) return {};
  return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, /key|secret|token|password/i.test(k) ? '********' : v]));
}

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

export async function getMapping() {
  const [floors, roomTypes, rooms, devices, adapters] = await Promise.all([
    Room.listFloors(),
    Room.listRoomTypes(),
    Room.listWithFloorAndType(),
    Device.listActiveWithAdapterName(),
    Device.listAdapters(),
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

/** Finds problems in a mapping before anything is saved. */
function mappingErrors({ floors, roomTypes, adapters, rooms }, allDevices) {
  const dup = (list, key) => list.map(key).find((v, i, arr) => arr.indexOf(v) !== i);
  const errs = [];
  if (dup(floors, (f) => f.number) !== undefined) errs.push('Duplicate floor number');
  if (dup(rooms, (r) => r.number)) errs.push(`Duplicate room number ${dup(rooms, (r) => r.number)}`);
  if (dup(adapters, (a) => a.name)) errs.push(`Duplicate adapter ${dup(adapters, (a) => a.name)}`);
  const dupDevice = dup(allDevices, (d) => `${d.adapter}|${d.externalId}`);
  if (dupDevice) errs.push(`Device ${dupDevice.replace('|', ' / ')} is mapped to more than one room`);
  for (const a of adapters) if (!VENDORS[a.vendor]) errs.push(`Unknown adapter vendor "${a.vendor}"`);
  const floorNumbers = new Set(floors.map((f) => f.number));
  for (const r of rooms) if (!floorNumbers.has(r.floor)) errs.push(`Room ${r.number} uses floor ${r.floor} which is not in the floors list`);
  const typeNames = new Set(roomTypes);
  for (const r of rooms) if (r.roomType && !typeNames.has(r.roomType)) errs.push(`Room ${r.number} uses room type "${r.roomType}" which is not in the roomTypes list`);
  return errs;
}

/**
 * Replaces the whole room/floor/device mapping in one transaction.
 * Rooms and devices left out are deactivated (never deleted, so history stays intact).
 */
export async function putMapping(input, actor) {
  const { floors = [], roomTypes = [], adapters = [], rooms = [] } = input;
  const allDevices = rooms.flatMap((r) => (r.devices || []).map((d) => ({ ...d, room: r.number })));
  const errs = mappingErrors({ floors, roomTypes, adapters, rooms }, allDevices);
  if (errs.length) throw badRequest('Mapping is not valid', errs.map((message) => ({ field: 'body', message })));

  const result = await transaction(async (trx) => {
    // Floors and room types
    for (const f of floors) await Room.upsertFloor(f.number, f.name, trx);
    for (const name of roomTypes) await Room.insertRoomTypeIfMissing(name, trx);
    const floorId = await Room.floorIdsByNumber(trx);
    const typeId = await Room.roomTypeIdsByName(trx);

    // Adapters. The dashboard receives masked credentials; keep the stored value when a mask comes back.
    for (const a of adapters) {
      const row = { name: a.name, vendor: a.vendor, is_enabled: a.isEnabled ?? true };
      if (a.config) {
        const existing = (await Device.findAdapterConfigByName(a.name, trx))?.config || {};
        row.config = Object.fromEntries(Object.entries(a.config).map(([k, v]) => [k, v === '********' ? existing[k] : v]));
      }
      await Device.upsertAdapterByName(row, trx);
    }
    const adapterId = await Device.adapterIdsByName(trx);
    const missingAdapter = allDevices.find((d) => !adapterId.has(d.adapter));
    if (missingAdapter) throw badRequest(`Device ${missingAdapter.externalId} uses unknown adapter "${missingAdapter.adapter}"`);

    // Rooms
    for (const r of rooms) {
      await Room.upsertByNumber({ number: r.number, floorId: floorId.get(r.floor), roomTypeId: r.roomType ? typeId.get(r.roomType) : null, isActive: r.isActive ?? true }, trx);
    }
    const deactivatedRooms = await Room.deactivateAllExcept(rooms.map((r) => r.number), trx);
    const roomId = await Room.idsByNumber(trx);

    // Devices
    const keep = [];
    for (const d of allDevices) {
      const aId = adapterId.get(d.adapter);
      await Device.upsertByAdapterAndExternalId(
        { adapter_id: aId, external_id: d.externalId, room_id: roomId.get(d.room), type: d.type, name: d.name ?? null, is_active: true, capabilities: d.capabilities ?? null },
        ['room_id', 'type', 'name', 'is_active', ...(d.capabilities !== undefined ? ['capabilities'] : [])],
        trx,
      );
      keep.push(`${aId}|${d.externalId}`);
    }
    const active = await Device.listActiveIdentities(trx);
    const removeIds = active.filter((d) => !keep.includes(`${d.adapter_id}|${d.external_id}`)).map((d) => d.id);
    if (removeIds.length) await Device.updateMany(removeIds, { is_active: false, room_id: null }, trx);

    // Remove floors and room types that nothing uses any more
    await Room.deleteUnusedFloorsExcept(floors.map((f) => f.number), trx);
    await Room.deleteUnusedRoomTypesExcept(roomTypes, trx);

    const summary = { floors: floors.length, rooms: rooms.length, devices: allDevices.length, roomsDeactivated: deactivatedRooms, devicesDeactivated: removeIds.length };
    await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'mapping.update', entityType: 'mapping', details: summary, ip: actor.ip }, trx);
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
  const adapter = await Device.findAdapter(adapterId);
  if (!adapter) throw notFound('Adapter');
  const secret = crypto.randomBytes(32).toString('base64url');
  await Device.updateAdapter(adapterId, { webhook_secret_hash: sha256(secret) });
  await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'adapter.secret_rotated', entityType: 'adapter', entityId: adapterId, ip: actor.ip });
  return { adapterId, webhookSecret: secret, webhookUrl: `/integrations/adapters/${adapterId}/events` };
}

export async function listAdapters() {
  return (await Device.listAdapters()).map(publicAdapter);
}

export async function getAdapter(id) {
  return (await listAdapters()).find((a) => a.id === id);
}
