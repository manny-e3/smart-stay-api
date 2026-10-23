import { bus, EVENTS } from './events.js';
import { emitToPermission, emitToStay, disconnectStay } from './sockets.js';
import { db } from '../config/db.js';
import { getRoomSummary } from '../modules/rooms/board.service.js';
import { getSettings } from '../modules/settings/settings.service.js';
import { GUEST_DEVICE_TYPES, roomEcoState, toGuestDevice } from '../modules/controls/controls.service.js';
import { roomStatusOf } from '../modules/guest/roomStatus.service.js';
import { toGuestRequest } from '../modules/requests/requests.service.js';

/**
 * Connects domain events to live updates over Socket.IO.
 *
 * Staff dashboard (default namespace), sent to the roles allowed to see them:
 *   board:room       { room summary }             - one room changed (board:read)
 *   board:refresh    {}                           - reload the whole board (board:read)
 *   request:created  { request }                  - new request; play the sound (requests:read)
 *   request:updated  { request }                  - status, assignee or escalation changed (requests:read)
 *   alert:created    { alert }                    - (alerts:read)
 *   alert:updated    { alert }                    - grouped repeat or resolved (alerts:read)
 *   feedback:created { feedback }                 - (feedback:read)
 *   adapter:health   { adapterId, from, to }      - (mapping:manage)
 *   rule:run         { ruleId, run }              - (rules:manage)
 *   stay:updated     { stayId, action }           - booking changed; reload it (stays:read)
 *   notification     { title, body, data }        - toast or browser notification
 *
 * Guest app ("/guest" namespace), sent only to the stay's own phones:
 *   device:state     { guest device }             - a light, AC, curtain, TV or speaker changed
 *   room:status      { dnd, cleaningRequested, cleaningRequestedAt, eco }
 *   request:updated  { guest request }            - status of one of their requests changed
 *   stay:moved       { roomNumber }               - reload /guest/me, /guest/devices and /guest/key
 *   session:ended    { reason }                   - checked out or access reset; sign in again
 */

// Several events for the same room within a short window are sent as one update.
const BOARD_DEBOUNCE_MS = 250;
const pending = new Map();

const stayInRoom = (roomId) => db('stays').where({ room_id: roomId, status: 'checked_in' }).first('id');

async function pushGuestRoomStatus(roomId) {
  const stay = await stayInRoom(roomId);
  if (!stay) return;
  const [room, eco] = await Promise.all([db('rooms').where({ id: roomId }).first(), roomEcoState(roomId)]);
  const { cleaningRequestId, ...status } = roomStatusOf(room); // eslint-disable-line no-unused-vars
  emitToStay(stay.id, 'room:status', { ...status, eco });
}

function scheduleRoomUpdate(roomId) {
  if (pending.has(roomId)) return;
  pending.set(
    roomId,
    setTimeout(async () => {
      pending.delete(roomId);
      try {
        const summary = await getRoomSummary(roomId);
        if (summary) emitToPermission('board:read', 'board:room', summary);
        await pushGuestRoomStatus(roomId);
      } catch (err) {
        console.error('[board] room update failed:', err.message);
      }
    }, BOARD_DEBOUNCE_MS),
  );
}

async function pushGuestDevice({ deviceId, roomId, type }) {
  if (!roomId || !GUEST_DEVICE_TYPES.includes(type)) return;
  const stay = await stayInRoom(roomId);
  if (!stay) return;
  const device = await db('devices as d').leftJoin('device_states as s', 's.device_id', 'd.id').where('d.id', deviceId).first('d.*', 's.state', 's.online', 's.last_seen_at');
  if (device) emitToStay(stay.id, 'device:state', toGuestDevice(device, await getSettings()));
}

async function pushGuestRequest(request) {
  if (!request?.stayId) return;
  const row = await db('requests as q').join('rooms as r', 'r.id', 'q.room_id').where('q.id', request.id).first('q.*', 'r.number as room_number');
  if (row) emitToStay(request.stayId, 'request:updated', toGuestRequest(row));
}

async function onStayChanged(e) {
  emitToPermission('stays:read', 'stay:updated', e);
  if (e.action === 'checked_out' || e.action === 'guest_access_reset') {
    emitToStay(e.stayId, 'session:ended', { reason: e.action });
    disconnectStay(e.stayId);
  } else if (e.action === 'moved') {
    const stay = await db('stays as s').join('rooms as r', 'r.id', 's.room_id').where('s.id', e.stayId).first('r.number');
    emitToStay(e.stayId, 'stay:moved', { roomNumber: stay?.number });
  }
}

let registered = false;

export function registerListeners() {
  if (registered) return;
  registered = true;
  bus.on(EVENTS.ROOM_CHANGED, ({ roomId }) => scheduleRoomUpdate(roomId));
  bus.on(EVENTS.BOARD_CHANGED, () => emitToPermission('board:read', 'board:refresh', {}));
  bus.on(EVENTS.REQUEST_CREATED, (request) => emitToPermission('requests:read', 'request:created', request));
  bus.on(EVENTS.REQUEST_UPDATED, (request) => {
    emitToPermission('requests:read', 'request:updated', request);
    return pushGuestRequest(request);
  });
  bus.on(EVENTS.ALERT_CREATED, (alert) => emitToPermission('alerts:read', 'alert:created', alert));
  bus.on(EVENTS.ALERT_UPDATED, (alert) => emitToPermission('alerts:read', 'alert:updated', alert));
  bus.on(EVENTS.FEEDBACK_CREATED, (feedback) => emitToPermission('feedback:read', 'feedback:created', feedback));
  bus.on(EVENTS.ADAPTER_HEALTH_CHANGED, (e) => emitToPermission('mapping:manage', 'adapter:health', e));
  bus.on(EVENTS.RULE_RUN, (e) => emitToPermission('rules:manage', 'rule:run', e));
  bus.on(EVENTS.STAY_CHANGED, onStayChanged);
  bus.on(EVENTS.DEVICE_STATE, pushGuestDevice);
}

export function clearPendingRoomUpdates() {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}
