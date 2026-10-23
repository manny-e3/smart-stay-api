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
      is_active: isActive,
      image_url: imageUrl,
      images: json(images),
    });

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

    bus.publish(EVENTS.BOARD_CHANGED, {});

    const updated = await trx('rooms as r')
      .join('floors as f', 'f.id', 'r.floor_id')
      .leftJoin('room_types as t', 't.id', 'r.room_type_id')
      .where('r.id', id)
      .first('r.id', 'r.number', 'r.dnd', 'r.is_active as isActive', 'r.image_url as imageUrl', 'r.images', 'f.number as floor', 't.name as roomType');

    const resImages = Array.isArray(updated.images) ? updated.images : typeof updated.images === 'string' ? JSON.parse(updated.images || '[]') : [];
    return { ...updated, images: resImages };
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

    const [staysRow, reqRow, alertRow] = await Promise.all([
      trx('stays').where({ room_id: id }).count({ c: '*' }).first(),
      trx('requests').where({ room_id: id }).count({ c: '*' }).first(),
      trx('alerts').where({ room_id: id }).count({ c: '*' }).first(),
    ]);

    const hasHistory = (Number(staysRow?.c) || 0) > 0 || (Number(reqRow?.c) || 0) > 0 || (Number(alertRow?.c) || 0) > 0;

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
