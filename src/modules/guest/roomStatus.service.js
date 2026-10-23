import { db } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { badRequest } from '../../core/errors.js';
import { bus, EVENTS } from '../../core/events.js';
import { announceRequest, getRequest, insertGuestRequest } from '../requests/requests.service.js';

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
  return roomStatusOf(await db('rooms').where({ id: roomId }).first());
}

export async function setRoomStatus({ roomId, stayId, guestId }, { dnd, cleaningRequested, note }) {
  if (dnd === true && cleaningRequested === true) throw badRequest('Do not disturb and room cleaning cannot both be on');
  let created = null;
  let cancelled = null;
  const changes = {};

  await db.transaction(async (trx) => {
    const room = await trx('rooms').where({ id: roomId }).forUpdate().first();
    const now = new Date();
    const update = {};

    const cancelCleaning = async (reason) => {
      if (room.cleaning_request_id) {
        const req = await trx('requests').where({ id: room.cleaning_request_id }).forUpdate().first();
        if (req && ['new', 'assigned'].includes(req.status)) {
          await trx('requests').where({ id: req.id }).update({ status: 'cancelled' });
          await trx('request_events').insert({ request_id: req.id, actor_type: 'guest', action: 'status_changed', from_status: req.status, to_status: 'cancelled', note: reason });
          cancelled = req.id;
        }
      }
      Object.assign(update, { cleaning_requested: false, cleaning_requested_at: null, cleaning_request_id: null });
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
      await trx('rooms').where({ id: roomId }).update(update);
      await audit({ actor: { type: 'guest', id: guestId }, action: 'room.status', entityType: 'stay', entityId: stayId, roomId, details: changes }, trx);
    }
  });

  if (created) await announceRequest(created);
  if (cancelled) bus.publish(EVENTS.REQUEST_UPDATED, await getRequest(cancelled));
  if (Object.keys(changes).length) bus.publish(EVENTS.ROOM_CHANGED, { roomId });
  return getRoomStatus(roomId);
}
