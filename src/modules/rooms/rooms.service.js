import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, json } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { bus, EVENTS } from '../../core/events.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.resolve(__dirname, '../../../uploads');

export async function uploadRoomPhoto(dataUrl, actor) {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw badRequest('Invalid data URL');
  }
  const matches = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
  if (!matches) {
    throw badRequest('Image must be a valid base64 data URL (e.g. data:image/jpeg;base64,...)');
  }
  let ext = matches[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (ext.includes('+')) ext = ext.split('+')[0];

  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, 'base64');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  const filename = `room-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filePath = path.join(uploadsDir, filename);
  await fs.promises.writeFile(filePath, buffer);

  const url = `/uploads/${filename}`;
  return { url, filename, sizeBytes: buffer.length };
}

export async function createRoom(input, actor) {
  const number = String(input.number).trim();
  const floorNumber = Number(input.floor);
  const roomType = input.roomType ? String(input.roomType).trim() : null;
  const isActive = input.isActive ?? true;
  const basePrice = input.basePrice !== undefined && input.basePrice !== null ? Number(input.basePrice) : null;
  const imageUrl = input.imageUrl || (input.images?.length ? input.images[0] : null);
  const images = Array.isArray(input.images) ? input.images : input.imageUrl ? [input.imageUrl] : [];

  return await db.transaction(async (trx) => {
    const existing = await trx('rooms').where({ number }).first();
    if (existing) {
      if (existing.is_active) {
        throw conflict(`Room ${number} already exists`);
      }
      let floor = await trx('floors').where({ number: floorNumber }).first();
      if (!floor) {
        const [newFloorId] = await trx('floors').insert({ number: floorNumber, name: `Floor ${floorNumber}` });
        floor = { id: newFloorId, number: floorNumber };
      }
      let typeId = null;
      if (roomType) {
        let type = await trx('room_types').where({ name: roomType }).first();
        if (!type) {
          const [newTypeId] = await trx('room_types').insert({ name: roomType });
          typeId = newTypeId;
        } else {
          typeId = type.id;
        }
      }
      await trx('rooms').where({ id: existing.id }).update({
        floor_id: floor.id,
        room_type_id: typeId,
        is_active: isActive,
        image_url: imageUrl,
        images: json(images),
        updated_at: trx.fn.now(),
      });
      await audit({
        actor: { type: 'staff', id: actor.id },
        action: 'room.reactivate',
        entityType: 'room',
        entityId: existing.id,
        details: { number, floor: floorNumber, roomType, imageUrl, imagesCount: images.length },
        ip: actor.ip,
      }, trx);
      bus.publish(EVENTS.BOARD_CHANGED, {});
      return { id: existing.id, number, floor: floorNumber, roomType, isActive, imageUrl, images };
    }

    let floor = await trx('floors').where({ number: floorNumber }).first();
    if (!floor) {
      const [newFloorId] = await trx('floors').insert({ number: floorNumber, name: `Floor ${floorNumber}` });
      floor = { id: newFloorId, number: floorNumber };
    }

    let typeId = null;
    if (roomType) {
      let type = await trx('room_types').where({ name: roomType }).first();
      if (!type) {
        const [newTypeId] = await trx('room_types').insert({ name: roomType });
        typeId = newTypeId;
      } else {
        typeId = type.id;
      }
    }

    const [id] = await trx('rooms').insert({
      number,
      floor_id: floor.id,
      room_type_id: typeId,
      base_price: basePrice !== null ? basePrice : (type?.base_price ? Number(type.base_price) : null),
      is_active: isActive,
      image_url: imageUrl,
      images: json(images),
    });

    if (Array.isArray(input.devices) && input.devices.length > 0) {
      const defaultAdapter = await trx('adapters').where({ is_enabled: true }).first('id');
      const adapterId = defaultAdapter?.id || 1;
      for (const d of input.devices) {
        if (d.isActive !== false) {
          const cleanName = (d.name || d.type).trim();
          const ext = d.externalId || (d.type + '-' + cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + number);
          const [devId] = await trx('devices').insert({
            adapter_id: adapterId,
            external_id: ext,
            room_id: id,
            type: d.type,
            name: cleanName,
            capabilities: d.capabilities ? json(d.capabilities) : null,
            is_active: true,
          }).onConflict(['adapter_id', 'external_id']).merge();

          const actualId = devId || (await trx('devices').where({ adapter_id: adapterId, external_id: ext }).first('id'))?.id;
          if (actualId) {
            await trx('device_states').insert({
              device_id: actualId,
              online: true,
              state: json(d.type === 'thermostat' ? { mode: 'cool', setpoint: 22 } : d.type === 'lock' ? { locked: true } : { on: false }),
              last_seen_at: new Date(),
            }).onConflict('device_id').ignore();
          }
        }
      }
    }

    await audit({
      actor: { type: 'staff', id: actor.id },
      action: 'room.create',
      entityType: 'room',
      entityId: id,
      details: { number, floor: floorNumber, roomType, imageUrl, imagesCount: images.length },
      ip: actor.ip,
    }, trx);

    bus.publish(EVENTS.BOARD_CHANGED, {});
    return { id, number, floor: floorNumber, roomType, isActive, imageUrl, images };
  });
}

export async function updateRoom(id, input, actor) {
  const room = await db('rooms').where({ id }).first();
  if (!room) throw notFound('Room');

  return await db.transaction(async (trx) => {
    const updates = {};
    const auditDetails = {};

    if (input.number !== undefined) {
      const number = String(input.number).trim();
      if (number !== room.number) {
        const dup = await trx('rooms').where({ number }).whereNot({ id }).first();
        if (dup) throw conflict(`Room number ${number} is already in use`);
        updates.number = number;
        auditDetails.number = number;
      }
    }

    if (input.floor !== undefined) {
      const floorNumber = Number(input.floor);
      let floor = await trx('floors').where({ number: floorNumber }).first();
      if (!floor) {
        const [newFloorId] = await trx('floors').insert({ number: floorNumber, name: `Floor ${floorNumber}` });
        floor = { id: newFloorId, number: floorNumber };
      }
      updates.floor_id = floor.id;
      auditDetails.floor = floorNumber;
    }

    if (input.roomType !== undefined) {
      if (!input.roomType || !String(input.roomType).trim()) {
        updates.room_type_id = null;
        auditDetails.roomType = null;
      } else {
        const typeName = String(input.roomType).trim();
        let type = await trx('room_types').where({ name: typeName }).first();
        if (!type) {
          const [newTypeId] = await trx('room_types').insert({ name: typeName });
          type = { id: newTypeId, name: typeName };
        }
        updates.room_type_id = type.id;
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
      updates.images = json(imgs);
      if (input.imageUrl === undefined && imgs.length > 0 && !room.image_url) {
        updates.image_url = imgs[0];
      }
      auditDetails.imagesCount = imgs.length;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = trx.fn.now();
      await trx('rooms').where({ id }).update(updates);
    }

    await audit({
      actor: { type: 'staff', id: actor.id },
      action: 'room.update',
      entityType: 'room',
      entityId: id,
      details: auditDetails,
      ip: actor.ip,
    }, trx);


    if (Array.isArray(input.devices)) {
      const defaultAdapter = await trx('adapters').where({ is_enabled: true }).first('id');
      const adapterId = defaultAdapter?.id || 1;
      const currentDevs = await trx('devices').where({ room_id: id });
      const requestedIds = new Set(input.devices.map((d) => d.id).filter(Boolean));

      // Deactivate devices that were unlinked or removed from this room
      for (const cd of currentDevs) {
        if (!requestedIds.has(cd.id)) {
          await trx('devices').where({ id: cd.id }).update({ room_id: null, is_active: false, updated_at: trx.fn.now() });
        }
      }

      // Add or update requested devices
      for (const d of input.devices) {
        const cleanName = (d.name || d.type).trim();
        if (d.id) {
          await trx('devices').where({ id: d.id }).update({
            name: cleanName,
            type: d.type,
            is_active: d.isActive !== false,
            updated_at: trx.fn.now(),
          });
        } else if (d.isActive !== false) {
          const ext = d.externalId || `${d.type}-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${room.number}`;
          const [devId] = await trx('devices').insert({
            adapter_id: adapterId,
            external_id: ext,
            room_id: id,
            type: d.type,
            name: cleanName,
            capabilities: d.capabilities ? json(d.capabilities) : null,
            is_active: true,
          }).onConflict(['adapter_id', 'external_id']).merge();

          const actualId = devId || (await trx('devices').where({ adapter_id: adapterId, external_id: ext }).first('id'))?.id;
          if (actualId) {
            await trx('device_states').insert({
              device_id: actualId,
              online: true,
              state: json(d.type === 'thermostat' ? { mode: 'cool', setpoint: 22 } : d.type === 'lock' ? { locked: true } : { on: false }),
              last_seen_at: new Date(),
            }).onConflict('device_id').ignore();
          }
        }
      }
    }

    bus.publish(EVENTS.BOARD_CHANGED, {});

    const updated = await trx('rooms as r')
      .join('floors as f', 'f.id', 'r.floor_id')
      .leftJoin('room_types as t', 't.id', 'r.room_type_id')
      .where('r.id', id)
      .first('r.id', 'r.number', 'r.base_price', 'r.dnd', 'r.is_active as isActive', 'r.image_url as imageUrl', 'r.images', 'f.number as floor', 't.name as roomType', 't.base_price as typeBasePrice');

    const resImages = Array.isArray(updated.images) ? updated.images : typeof updated.images === 'string' ? JSON.parse(updated.images || '[]') : [];
    const resolvedPrice = updated.base_price != null ? Number(updated.base_price) : (updated.typeBasePrice != null ? Number(updated.typeBasePrice) : null);
    const roomDevs = await trx('devices as d')
      .leftJoin('adapters as a', 'a.id', 'd.adapter_id')
      .leftJoin('device_states as ds', 'ds.device_id', 'd.id')
      .where({ 'd.room_id': id, 'd.is_active': true })
      .select('d.id', 'd.type', 'd.name', 'd.external_id', 'a.name as adapter', 'ds.online', 'ds.state');
    return { ...updated, basePrice: resolvedPrice, price: resolvedPrice, images: resImages, devices: roomDevs };
  });
}

export async function deleteRoom(id, actor) {
  const room = await db('rooms').where({ id }).first();
  if (!room) throw notFound('Room');

  return await db.transaction(async (trx) => {
    const activeStay = await trx('stays').where({ room_id: id, status: 'checked_in' }).first();
    if (activeStay) {
      throw badRequest('Cannot delete room with an active checked-in guest', [
        { field: 'id', message: 'Room currently has an active guest stay' },
      ]);
    }

    await trx('devices').where({ room_id: id }).update({ room_id: null, is_active: false });

    const [staysRow, reqRow, alertRow, auditRow] = await Promise.all([
      trx('stays').where({ room_id: id }).count({ c: '*' }).first(),
      trx('requests').where({ room_id: id }).count({ c: '*' }).first(),
      trx('alerts').where({ room_id: id }).count({ c: '*' }).first(),
      trx('audit_log').where({ room_id: id }).count({ c: '*' }).first(),
    ]);

    const hasHistory = (Number(staysRow?.c) || 0) > 0 || (Number(reqRow?.c) || 0) > 0 || (Number(alertRow?.c) || 0) > 0 || (Number(auditRow?.c) || 0) > 0;

    if (hasHistory) {
      await trx('rooms').where({ id }).update({ is_active: false, updated_at: trx.fn.now() });
    } else {
      await trx('rooms').where({ id }).del();
    }

    await audit({
      actor: { type: 'staff', id: actor.id },
      action: 'room.delete',
      entityType: 'room',
      entityId: id,
      details: { number: room.number, softDeleted: hasHistory },
      ip: actor.ip,
    }, trx);

    bus.publish(EVENTS.BOARD_CHANGED, {});
    return { id, number: room.number, softDeleted: hasHistory, success: true };
  });
}


export async function getRoomDevicesList(roomId) {
  const room = await db('rooms').where({ id: roomId }).first();
  if (!room) throw notFound('Room');

  return db('devices as d')
    .leftJoin('adapters as a', 'a.id', 'd.adapter_id')
    .leftJoin('device_states as ds', 'ds.device_id', 'd.id')
    .where({ 'd.room_id': roomId })
    .orderBy(['d.type', 'd.name'])
    .select('d.id', 'd.type', 'd.name', 'd.external_id', 'd.capabilities', 'd.is_active as isActive', 'a.name as adapter', 'ds.online', 'ds.state', 'ds.last_seen_at as lastSeenAt');
}

export async function addDeviceToRoom(roomId, input, actor) {
  const room = await db('rooms').where({ id: roomId }).first();
  if (!room) throw notFound('Room');

  const defaultAdapter = await db('adapters').where({ is_enabled: true }).first('id');
  const adapterId = input.adapterId || defaultAdapter?.id || 1;
  const cleanName = (input.name || input.type).trim();
  const rawExt = input.externalId || `${input.type}-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${room.number}`;

  let externalId = rawExt;
  const existing = await db('devices').where({ adapter_id: adapterId, external_id: externalId }).first();
  if (existing) {
    if (existing.room_id === Number(roomId)) {
      await db('devices').where({ id: existing.id }).update({
        is_active: true,
        name: cleanName,
        type: input.type,
        capabilities: input.capabilities ? json(input.capabilities) : existing.capabilities,
        updated_at: db.fn.now(),
      });
      bus.publish(EVENTS.ROOM_CHANGED, { roomId });
      return { id: existing.id, type: input.type, name: cleanName, externalId, roomId, isActive: true };
    }
    externalId = `${rawExt}-${Date.now().toString().slice(-4)}`;
  }

  const [id] = await db('devices').insert({
    adapter_id: adapterId,
    external_id: externalId,
    room_id: roomId,
    type: input.type,
    name: cleanName,
    capabilities: input.capabilities ? json(input.capabilities) : null,
    is_active: input.isActive !== false,
  });

  await db('device_states').insert({
    device_id: id,
    online: true,
    state: json(input.type === 'thermostat' ? { mode: 'cool', setpoint: 22 } : input.type === 'lock' ? { locked: true } : { on: false }),
    last_seen_at: new Date(),
  }).onConflict('device_id').ignore();

  await audit({
    actor: { type: 'staff', id: actor.id },
    action: 'device.create',
    entityType: 'device',
    entityId: id,
    roomId,
    details: { name: cleanName, type: input.type, externalId },
    ip: actor.ip,
  });

  bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return { id, type: input.type, name: cleanName, externalId, roomId, adapterId, isActive: input.isActive !== false };
}

export async function updateRoomDevice(roomId, deviceId, input, actor) {
  const device = await db('devices').where({ id: deviceId, room_id: roomId }).first();
  if (!device) throw notFound('Device in this room');

  const updates = {};
  if (input.name !== undefined) updates.name = input.name.trim();
  if (input.type !== undefined) updates.type = input.type;
  if (input.isActive !== undefined) updates.is_active = Boolean(input.isActive);
  if (input.capabilities !== undefined) updates.capabilities = input.capabilities ? json(input.capabilities) : null;
  if (input.roomId !== undefined) updates.room_id = input.roomId;

  if (Object.keys(updates).length > 0) {
    updates.updated_at = db.fn.now();
    await db('devices').where({ id: deviceId }).update(updates);
  }

  await audit({
    actor: { type: 'staff', id: actor.id },
    action: 'device.update',
    entityType: 'device',
    entityId: deviceId,
    roomId,
    details: input,
    ip: actor.ip,
  });

  bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return db('devices').where({ id: deviceId }).first();
}

export async function deleteRoomDevice(roomId, deviceId, actor) {
  const device = await db('devices').where({ id: deviceId, room_id: roomId }).first();
  if (!device) throw notFound('Device in this room');

  await db('devices').where({ id: deviceId }).update({
    room_id: null,
    is_active: false,
    updated_at: db.fn.now(),
  });

  await audit({
    actor: { type: 'staff', id: actor.id },
    action: 'device.unassign',
    entityType: 'device',
    entityId: deviceId,
    roomId,
    details: { name: device.name, type: device.type },
    ip: actor.ip,
  });

  bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return { success: true, id: deviceId };
}
