import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transaction } from '../config/db.js';
import * as Room from '../models/room.model.js';
import * as Device from '../models/device.model.js';
import * as Stay from '../models/stay.model.js';
import { recordAudit } from './audit.service.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { bus, EVENTS } from '../realtime/eventBus.js';

/** Adding, editing and removing rooms and the devices in them (one room at a time). */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, '../../uploads');

const staffActor = (actor) => ({ type: 'staff', id: actor.id });
const parseImages = (images) => (Array.isArray(images) ? images : typeof images === 'string' ? JSON.parse(images || '[]') : []);

/** Vendor device id for a device added by hand, e.g. "light-bedside-101". */
const generatedExternalId = (type, name, roomNumber) => `${type}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${roomNumber}`;

/** Saves a base64 data-URL image under /uploads and returns its public URL. */
export async function uploadRoomPhoto(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') throw badRequest('Invalid data URL');
  const matches = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
  if (!matches) throw badRequest('Image must be a valid base64 data URL (e.g. data:image/jpeg;base64,...)');
  let ext = matches[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (ext.includes('+')) ext = ext.split('+')[0];

  const buffer = Buffer.from(matches[2], 'base64');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = `room-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(uploadsDir, filename), buffer);
  return { url: `/uploads/${filename}`, filename, sizeBytes: buffer.length };
}

/** Adds devices to a new or edited room, attached to the first enabled adapter. */
async function addDevices(trx, roomId, roomNumber, devices) {
  const adapterId = (await Device.firstEnabledAdapter(trx))?.id || 1;
  for (const d of devices) {
    if (d.isActive === false) continue;
    const name = (d.name || d.type).trim();
    const externalId = d.externalId || generatedExternalId(d.type, name, roomNumber);
    const [devId] = await Device.upsertByAdapterAndExternalId(
      { adapter_id: adapterId, external_id: externalId, room_id: roomId, type: d.type, name, capabilities: d.capabilities ?? null, is_active: true },
      null,
      trx,
    );
    const actualId = devId || (await Device.findByAdapterAndExternalId(adapterId, externalId, trx))?.id;
    if (actualId) await Device.insertDefaultState(actualId, d.type, trx);
  }
}

/** Creates a room (and its floor and room type if needed). Re-creating a deactivated room number reactivates it. */
export async function createRoom(input, actor) {
  const number = String(input.number).trim();
  const floorNumber = Number(input.floor);
  const roomType = input.roomType ? String(input.roomType).trim() : null;
  const isActive = input.isActive ?? true;
  const basePrice = input.basePrice !== undefined && input.basePrice !== null ? Number(input.basePrice) : null;
  const imageUrl = input.imageUrl || (input.images?.length ? input.images[0] : null);
  const images = Array.isArray(input.images) ? input.images : input.imageUrl ? [input.imageUrl] : [];

  return transaction(async (trx) => {
    const floor = await Room.findOrCreateFloor(floorNumber, trx);
    const type = roomType ? await Room.findOrCreateRoomType(roomType, trx) : null;
    const existing = await Room.findByNumber(number, trx);

    if (existing) {
      if (existing.is_active) throw conflict(`Room ${number} already exists`);
      await Room.update(existing.id, { floor_id: floor.id, room_type_id: type?.id ?? null, is_active: isActive, image_url: imageUrl, images, updated_at: trx.fn.now() }, trx);
      await recordAudit({ actor: staffActor(actor), action: 'room.reactivate', entityType: 'room', entityId: existing.id, details: { number, floor: floorNumber, roomType, imageUrl, imagesCount: images.length }, ip: actor.ip }, trx);
      bus.publish(EVENTS.BOARD_CHANGED, {});
      return { id: existing.id, number, floor: floorNumber, roomType, isActive, imageUrl, images };
    }

    // Without its own price, a room uses its room type's price.
    const id = await Room.create(
      {
        number,
        floor_id: floor.id,
        room_type_id: type?.id ?? null,
        base_price: basePrice !== null ? basePrice : type?.base_price ? Number(type.base_price) : null,
        is_active: isActive,
        image_url: imageUrl,
        images,
      },
      trx,
    );
    if (Array.isArray(input.devices) && input.devices.length) await addDevices(trx, id, number, input.devices);

    await recordAudit({ actor: staffActor(actor), action: 'room.create', entityType: 'room', entityId: id, details: { number, floor: floorNumber, roomType, imageUrl, imagesCount: images.length }, ip: actor.ip }, trx);
    bus.publish(EVENTS.BOARD_CHANGED, {});
    return { id, number, floor: floorNumber, roomType, isActive, imageUrl, images };
  });
}

/** Edits a room. When `devices` is sent, it becomes the room's device list. */
export async function updateRoom(id, input, actor) {
  const room = await Room.findById(id);
  if (!room) throw notFound('Room');

  return transaction(async (trx) => {
    const updates = {};
    const auditDetails = {};

    if (input.number !== undefined) {
      const number = String(input.number).trim();
      if (number !== room.number) {
        if (await Room.findByNumberExcept(number, id, trx)) throw conflict(`Room number ${number} is already in use`);
        updates.number = number;
        auditDetails.number = number;
      }
    }
    if (input.floor !== undefined) {
      const floorNumber = Number(input.floor);
      updates.floor_id = (await Room.findOrCreateFloor(floorNumber, trx)).id;
      auditDetails.floor = floorNumber;
    }
    if (input.roomType !== undefined) {
      if (!input.roomType || !String(input.roomType).trim()) {
        updates.room_type_id = null;
        auditDetails.roomType = null;
      } else {
        const typeName = String(input.roomType).trim();
        updates.room_type_id = (await Room.findOrCreateRoomType(typeName, trx)).id;
        auditDetails.roomType = typeName;
      }
    }
    if (input.basePrice !== undefined) {
      updates.base_price = input.basePrice !== null ? Number(input.basePrice) : null;
      auditDetails.basePrice = updates.base_price;
    }
    if (input.isActive !== undefined) {
      updates.is_active = Boolean(input.isActive);
      auditDetails.isActive = updates.is_active;
    }
    if (input.dnd !== undefined) {
      updates.dnd = Boolean(input.dnd);
      updates.dnd_updated_at = trx.fn.now();
      auditDetails.dnd = updates.dnd;
    }
    if (input.imageUrl !== undefined) {
      updates.image_url = input.imageUrl || null;
      auditDetails.imageUrl = updates.image_url;
    }
    if (input.images !== undefined) {
      const imgs = Array.isArray(input.images) ? input.images : [];
      updates.images = imgs;
      if (input.imageUrl === undefined && imgs.length > 0 && !room.image_url) updates.image_url = imgs[0];
      auditDetails.imagesCount = imgs.length;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = trx.fn.now();
      await Room.update(id, updates, trx);
    }
    await recordAudit({ actor: staffActor(actor), action: 'room.update', entityType: 'room', entityId: id, details: auditDetails, ip: actor.ip }, trx);

    if (Array.isArray(input.devices)) {
      const requestedIds = new Set(input.devices.map((d) => d.id).filter(Boolean));
      // Devices no longer in the list are unlinked and deactivated.
      for (const cd of await Device.listInRoom(id, trx)) {
        if (!requestedIds.has(cd.id)) await Device.update(cd.id, { room_id: null, is_active: false, updated_at: trx.fn.now() }, trx);
      }
      for (const d of input.devices.filter((x) => x.id)) {
        await Device.update(d.id, { name: (d.name || d.type).trim(), type: d.type, is_active: d.isActive !== false, updated_at: trx.fn.now() }, trx);
      }
      await addDevices(trx, id, room.number, input.devices.filter((x) => !x.id));
    }

    bus.publish(EVENTS.BOARD_CHANGED, {});

    const updated = await Room.findWithFloorAndType(id, trx);
    const resolvedPrice = updated.base_price != null ? Number(updated.base_price) : updated.typeBasePrice != null ? Number(updated.typeBasePrice) : null;
    const devices = await Device.activeInRoomBrief(id, trx);
    return { ...updated, basePrice: resolvedPrice, price: resolvedPrice, images: parseImages(updated.images), devices };
  });
}

/** Deletes a room; one with history (stays, requests, alerts, audit) is deactivated instead. */
export async function deleteRoom(id, actor) {
  const room = await Room.findById(id);
  if (!room) throw notFound('Room');

  return transaction(async (trx) => {
    if (await Stay.findCheckedInForRoom(id, trx)) {
      throw badRequest('Cannot delete room with an active checked-in guest', [{ field: 'id', message: 'Room currently has an active guest stay' }]);
    }
    await Device.unassignAllInRoom(id, trx);
    const softDeleted = await Room.hasHistory(id, trx);
    if (softDeleted) await Room.update(id, { is_active: false, updated_at: trx.fn.now() }, trx);
    else await Room.remove(id, trx);

    await recordAudit({ actor: staffActor(actor), action: 'room.delete', entityType: 'room', entityId: id, details: { number: room.number, softDeleted }, ip: actor.ip }, trx);
    bus.publish(EVENTS.BOARD_CHANGED, {});
    return { id, number: room.number, softDeleted, success: true };
  });
}

/* ---- Devices in one room ---------------------------------------------------------- */

export async function getRoomDevicesList(roomId) {
  if (!(await Room.findById(roomId))) throw notFound('Room');
  return Device.listForRoomManagement(roomId);
}

export async function addDeviceToRoom(roomId, input, actor) {
  const room = await Room.findById(roomId);
  if (!room) throw notFound('Room');

  const adapterId = input.adapterId || (await Device.firstEnabledAdapter())?.id || 1;
  const name = (input.name || input.type).trim();
  const rawExternalId = input.externalId || generatedExternalId(input.type, name, room.number);
  let externalId = rawExternalId;

  const existing = await Device.findByAdapterAndExternalId(adapterId, externalId);
  if (existing) {
    // Same device already in this room: switch it back on with the new details.
    if (existing.room_id === Number(roomId)) {
      await Device.update(existing.id, { is_active: true, name, type: input.type, capabilities: input.capabilities ?? existing.capabilities, updated_at: new Date() });
      bus.publish(EVENTS.ROOM_CHANGED, { roomId });
      return { id: existing.id, type: input.type, name, externalId, roomId, isActive: true };
    }
    externalId = `${rawExternalId}-${Date.now().toString().slice(-4)}`;
  }

  const id = await Device.create({ adapter_id: adapterId, external_id: externalId, room_id: roomId, type: input.type, name, capabilities: input.capabilities ?? null, is_active: input.isActive !== false });
  await Device.insertDefaultState(id, input.type);
  await recordAudit({ actor: staffActor(actor), action: 'device.create', entityType: 'device', entityId: id, roomId, details: { name, type: input.type, externalId }, ip: actor.ip });

  bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return { id, type: input.type, name, externalId, roomId, adapterId, isActive: input.isActive !== false };
}

export async function updateRoomDevice(roomId, deviceId, input, actor) {
  if (!(await Device.findInRoom(deviceId, roomId))) throw notFound('Device in this room');

  const updates = {};
  if (input.name !== undefined) updates.name = input.name.trim();
  if (input.type !== undefined) updates.type = input.type;
  if (input.isActive !== undefined) updates.is_active = Boolean(input.isActive);
  if (input.capabilities !== undefined) updates.capabilities = input.capabilities ?? null;
  if (input.roomId !== undefined) updates.room_id = input.roomId;
  if (Object.keys(updates).length > 0) await Device.update(deviceId, { ...updates, updated_at: new Date() });

  await recordAudit({ actor: staffActor(actor), action: 'device.update', entityType: 'device', entityId: deviceId, roomId, details: input, ip: actor.ip });
  bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return Device.findById(deviceId);
}

export async function deleteRoomDevice(roomId, deviceId, actor) {
  const device = await Device.findInRoom(deviceId, roomId);
  if (!device) throw notFound('Device in this room');

  await Device.update(deviceId, { room_id: null, is_active: false, updated_at: new Date() });
  await recordAudit({ actor: staffActor(actor), action: 'device.unassign', entityType: 'device', entityId: deviceId, roomId, details: { name: device.name, type: device.type }, ip: actor.ip });

  bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return { success: true, id: deviceId };
}
