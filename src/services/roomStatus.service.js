import { transaction } from '../config/db.js';
import * as Room from '../models/room.model.js';
import * as Request from '../models/request.model.js';
import { recordAudit } from './audit.service.js';
import { badRequest } from '../utils/errors.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { announceRequest, getRequest, insertGuestRequest } from './requests.service.js';

/**
 * Room status from the guest app: do not disturb and "please clean my room".
 * They exclude each other, as on a physical doorplate: turning one on turns the other off.
 * A cleaning request becomes a housekeeping request, so it reaches the queue, escalates
 * and pushes status updates like any other request.
 */

export const roomStatusOf = (room) => ({
  dnd: Boolean(room.dnd),
  cleaningRequested: Boolean(room.cleaning_requested),
  cleaningRequestedAt: room.cleaning_requested_at ?? null,
  cleaningRequestId: room.cleaning_request_id ?? null,
});

export async function getRoomStatus(roomId) {
  return roomStatusOf(await Room.findById(roomId));
}

export async function setRoomStatus({ roomId, stayId, guestId }, { dnd, cleaningRequested, note }) {
  if (dnd === true && cleaningRequested === true) throw badRequest('Do not disturb and room cleaning cannot both be on');
  let created = null;
  let cancelled = null;
  const changes = {};

  await transaction(async (trx) => {
    const room = await Room.lockById(roomId, trx);
    const now = new Date();
    const update = {};

    const cancelCleaning = async (reason) => {
      if (room.cleaning_request_id) {
        const req = await Request.lockById(room.cleaning_request_id, trx);
        if (req && ['new', 'assigned'].includes(req.status)) {
          await Request.update(req.id, { status: 'cancelled' }, trx);
          await Request.addEvent({ requestId: req.id, actorType: 'guest', action: 'status_changed', fromStatus: req.status, toStatus: 'cancelled', note: reason }, trx);
          cancelled = req.id;
        }
      }
      Object.assign(update, Room.CLEAR_CLEANING);
    };

    if (cleaningRequested === true && !room.cleaning_requested) {
      created = await insertGuestRequest(trx, { roomId, stayId, guestId, category: 'housekeeping', description: note ? `Room cleaning requested: ${note}` : 'Room cleaning requested' });
      Object.assign(update, { cleaning_requested: true, cleaning_requested_at: now, cleaning_request_id: created, dnd: false });
      changes.cleaningRequested = true;
      if (room.dnd) changes.dnd = false;
    } else if (cleaningRequested === false && room.cleaning_requested) {
      await cancelCleaning('Guest no longer needs cleaning');
      changes.cleaningRequested = false;
    }

    if (dnd === true && !room.dnd) {
      update.dnd = true;
      changes.dnd = true;
      if (room.cleaning_requested) {
        await cancelCleaning('Guest turned on do not disturb');
        changes.cleaningRequested = false;
      }
    } else if (dnd === false && room.dnd) {
      update.dnd = false;
      changes.dnd = false;
    }
    if (update.dnd !== undefined) update.dnd_updated_at = now;

    if (Object.keys(update).length) {
      await Room.update(roomId, update, trx);
      await recordAudit({ actor: { type: 'guest', id: guestId }, action: 'room.status', entityType: 'stay', entityId: stayId, roomId, details: changes }, trx);
    }
  });

  if (created) await announceRequest(created);
  if (cancelled) bus.publish(EVENTS.REQUEST_UPDATED, await getRequest(cancelled));
  if (Object.keys(changes).length) bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return getRoomStatus(roomId);
}
