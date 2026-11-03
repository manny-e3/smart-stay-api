import { transaction } from '../config/db.js';
import * as Request from '../models/request.model.js';
import * as Room from '../models/room.model.js';
import * as Stay from '../models/stay.model.js';
import * as Staff from '../models/staff.model.js';
import { recordAudit } from './audit.service.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { can, rolesFor } from '../config/permissions.js';
import { notifyStaff, pushToGuest } from './notification.service.js';
import { emitToStaff } from '../realtime/socket.js';
import { getSettings } from './settings.service.js';

/** Guest service requests: the staff queue, the guest app's requests, and escalation. */

export const REQUEST_STATUSES = ['new', 'assigned', 'in_progress', 'done', 'cancelled'];
export const REQUEST_CATEGORIES = ['housekeeping', 'amenities', 'maintenance', 'food', 'laundry', 'other'];
export const REQUEST_PRIORITIES = ['normal', 'high', 'urgent'];
export const OPEN_STATUSES = ['new', 'assigned', 'in_progress'];

/** Allowed status changes. done and cancelled are final. */
export const TRANSITIONS = {
  new: ['assigned', 'in_progress', 'done', 'cancelled'],
  assigned: ['new', 'in_progress', 'done', 'cancelled'],
  in_progress: ['assigned', 'done', 'cancelled'],
  done: [],
  cancelled: [],
};

const GUEST_MESSAGES = {
  assigned: 'Your request has been assigned to a team member.',
  in_progress: 'We are working on your request now.',
  done: 'Your request has been completed.',
  cancelled: 'Your request has been cancelled.',
};

export const toRequest = (q) => ({
  id: q.id,
  category: q.category,
  description: q.description,
  priority: q.priority,
  status: q.status,
  source: q.source,
  room: { id: q.room_id, number: q.room_number, floor: q.floor_number },
  guest: q.guest_id ? { id: q.guest_id, name: [q.guest_first_name, q.guest_last_name].filter(Boolean).join(' ') } : null,
  stayId: q.stay_id,
  assignee: q.assigned_to ? { id: q.assigned_to, name: q.assignee_name } : null,
  createdBy: q.created_by_staff_id ? { id: q.created_by_staff_id, name: q.created_by_name } : null,
  escalated: Boolean(q.escalated_at),
  escalatedAt: q.escalated_at,
  completedAt: q.completed_at,
  preferredAt: q.preferred_at ?? null,
  createdAt: q.created_at,
  updatedAt: q.updated_at,
});

async function loadRequest(id) {
  const q = await Request.findWithDetails(id);
  return q ? toRequest(q) : null;
}

/* ---- Staff queue -------------------------------------------------------------- */

export async function listRequests(filters) {
  const result = await Request.list(filters);
  const counts = await Request.countByStatus(OPEN_STATUSES);
  return {
    ...result,
    items: result.items.map(toRequest),
    openCounts: Object.fromEntries(OPEN_STATUSES.map((s) => [s, Number(counts.find((c) => c.status === s)?.n ?? 0)])),
  };
}

/** Active staff whose role handles requests, with how many open requests each has. */
export async function listAssignees() {
  const rows = await Staff.listActiveInRoles(rolesFor('requests:write'), OPEN_STATUSES);
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, openRequests: Number(r.open) }));
}

export async function getRequest(id) {
  const request = await loadRequest(id);
  if (!request) throw notFound('Request');
  const history = await Request.history(id);
  return {
    ...request,
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      fromStatus: h.from_status,
      toStatus: h.to_status,
      note: h.note,
      data: h.data,
      actor: h.actor_type === 'staff' ? { type: 'staff', id: h.staff_id, name: h.staff_name } : { type: h.actor_type },
      at: h.created_at,
    })),
  };
}

async function afterCreate(request) {
  bus.publish(EVENTS.REQUEST_CREATED, request);
  bus.publish(EVENTS.ROOM_CHANGED, { roomId: request.room.id });
  await notifyStaff({
    permission: 'requests:read',
    title: `New ${request.category} request`,
    body: `Room ${request.room.number}${request.description ? `: ${request.description}` : ''}`,
    data: { type: 'request', requestId: request.id, roomId: request.room.id, sound: true },
  });
}

/** Staff creates a request on behalf of a guest (front desk call, in person). */
export async function createRequestForGuest({ roomId, category, description, priority = 'normal', preferredAt = null }, actor) {
  if (!(await Room.findActive(roomId))) throw badRequest('Room not found or inactive');
  const id = await transaction(async (trx) => {
    const stay = await Stay.findCheckedInForRoom(roomId, trx);
    const newId = await Request.create(
      {
        room_id: roomId, stay_id: stay?.id ?? null, guest_id: stay?.guest_id ?? null, category, description, priority,
        preferred_at: preferredAt, status: 'new', source: 'staff', created_by_staff_id: actor.id,
      },
      trx,
    );
    await Request.addEvent({ requestId: newId, staffId: actor.id, actorType: 'staff', action: 'created', toStatus: 'new', data: { onBehalfOfGuest: true } }, trx);
    await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'request.create', entityType: 'request', entityId: newId, roomId, details: { category, priority }, ip: actor.ip }, trx);
    return newId;
  });
  const request = await loadRequest(id);
  await afterCreate(request);
  return request;
}

/** Inserts a guest request inside a caller's transaction. Call announceRequest(id) after commit. */
export async function insertGuestRequest(trx, { roomId, stayId, guestId, category, description = null, priority = 'normal', preferredAt = null }) {
  const id = await Request.create({ room_id: roomId, stay_id: stayId, guest_id: guestId, category, description, priority, preferred_at: preferredAt, status: 'new', source: 'guest' }, trx);
  await Request.addEvent({ requestId: id, actorType: 'guest', action: 'created', toStatus: 'new' }, trx);
  return id;
}

/** Live update and staff notification for a newly created request. */
export async function announceRequest(id) {
  const request = await loadRequest(id);
  await afterCreate(request);
  return request;
}

/** Request created by a guest in the guest app. */
export async function createGuestRequest(input) {
  const id = await transaction((trx) => insertGuestRequest(trx, input));
  return announceRequest(id);
}

/** Clears the room's "cleaning requested" flag when its housekeeping request ends. */
async function clearCleaningFlag(trx, requestId) {
  const room = await Room.findByCleaningRequest(requestId, trx);
  if (!room) return null;
  await Room.update(room.id, Room.CLEAR_CLEANING, trx);
  return room.id;
}

/** Assigns, changes status or priority, or adds a note. Every change is kept in the history. */
export async function updateRequest(id, input, actor) {
  const { status, assignedTo, priority, note } = input;

  const outcome = await transaction(async (trx) => {
    const current = await Request.lockById(id, trx);
    if (!current) throw notFound('Request');
    if (!OPEN_STATUSES.includes(current.status) && (status || assignedTo !== undefined || priority)) {
      throw badRequest(`Request is ${current.status} and can no longer be changed`);
    }

    const patch = {};
    const events = [];
    let nextStatus = current.status;

    if (assignedTo !== undefined && assignedTo !== current.assigned_to) {
      if (assignedTo !== null) {
        const assignee = await Staff.findActiveInRoles(assignedTo, trx);
        if (!assignee || !can(assignee.role, 'requests:write')) throw badRequest('Assignee must be an active staff member who handles requests');
        events.push({ action: 'assigned', data: { assigneeId: assignee.id, assigneeName: assignee.name } });
      } else {
        events.push({ action: 'unassigned', data: { previousAssigneeId: current.assigned_to } });
      }
      patch.assigned_to = assignedTo;
      if (!status) {
        if (assignedTo !== null && current.status === 'new') nextStatus = 'assigned';
        if (assignedTo === null && current.status === 'assigned') nextStatus = 'new';
      }
    }

    if (status && status !== current.status) nextStatus = status;
    if (nextStatus !== current.status) {
      if (!TRANSITIONS[current.status].includes(nextStatus)) throw badRequest(`Cannot change status from ${current.status} to ${nextStatus}`);
      const assigneeAfter = patch.assigned_to !== undefined ? patch.assigned_to : current.assigned_to;
      if (nextStatus === 'assigned' && !assigneeAfter) throw badRequest('Choose a staff member to assign the request to');
      patch.status = nextStatus;
      if (nextStatus === 'done') patch.completed_at = new Date();
      events.push({ action: 'status_changed', fromStatus: current.status, toStatus: nextStatus });
    }

    if (priority && priority !== current.priority) {
      patch.priority = priority;
      events.push({ action: 'priority_changed', data: { from: current.priority, to: priority } });
    }

    if (note) {
      if (events.length) events[events.length - 1].note = note;
      else events.push({ action: 'note', note });
    }
    if (!events.length) return { changed: false, current };

    if (Object.keys(patch).length) await Request.update(id, patch, trx);
    if (patch.status === 'done' || patch.status === 'cancelled') await clearCleaningFlag(trx, id);
    for (const e of events) await Request.addEvent({ requestId: id, staffId: actor.id, actorType: 'staff', ...e }, trx);
    await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'request.update', entityType: 'request', entityId: id, roomId: current.room_id, details: { ...input }, ip: actor.ip }, trx);
    return { changed: true, current, statusChanged: patch.status, newAssignee: patch.assigned_to };
  });

  const request = await getRequest(id);
  if (!outcome.changed) return request;

  bus.publish(EVENTS.REQUEST_UPDATED, request);
  bus.publish(EVENTS.ROOM_CHANGED, { roomId: request.room.id });
  if (outcome.newAssignee && outcome.newAssignee !== actor.id) {
    emitToStaff(outcome.newAssignee, 'notification', {
      title: 'Request assigned to you',
      body: `Room ${request.room.number}: ${request.category}`,
      data: { type: 'request', requestId: id, sound: true },
      at: new Date().toISOString(),
    });
  }
  if (outcome.statusChanged && GUEST_MESSAGES[outcome.statusChanged]) {
    await pushToGuest(
      { stayId: request.stayId, guestId: request.guest?.id },
      { title: 'Request update', body: GUEST_MESSAGES[outcome.statusChanged], data: { type: 'request_status', requestId: id, status: outcome.statusChanged } },
    );
  }
  return request;
}

/** Background job: marks requests that have waited longer than the escalation time. */
export async function escalateOverdue(now = new Date()) {
  const { escalation_minutes: minutes } = await getSettings();
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const overdue = await Request.listOverdue(cutoff);
  const escalated = [];
  for (const { id } of overdue) {
    const updated = await transaction(async (trx) => {
      if (!(await Request.markEscalated(id, now, trx))) return false;
      await Request.addEvent({ requestId: id, actorType: 'system', action: 'escalated', data: { afterMinutes: minutes } }, trx);
      return true;
    });
    if (!updated) continue;
    const request = await loadRequest(id);
    escalated.push(request);
    bus.publish(EVENTS.REQUEST_ESCALATED, request);
    bus.publish(EVENTS.REQUEST_UPDATED, request);
    bus.publish(EVENTS.ROOM_CHANGED, { roomId: request.room.id });
    await notifyStaff({
      roles: ['manager', 'admin'],
      title: `Request escalated: room ${request.room.number}`,
      body: `${request.category} request waiting over ${minutes} minutes (${request.status})`,
      data: { type: 'request_escalated', requestId: id, roomId: request.room.id, sound: true },
      email: true,
    });
  }
  return escalated;
}

/* ---- Guest app view -------------------------------------------------------------- */

export const toGuestRequest = (q) => ({
  id: q.id,
  category: q.category,
  description: q.description,
  priority: q.priority,
  status: q.status,
  preferredAt: q.preferred_at ?? null,
  room: { number: q.room_number },
  canCancel: ['new', 'assigned'].includes(q.status),
  createdAt: q.created_at,
  updatedAt: q.updated_at,
  completedAt: q.completed_at ?? null,
});

export async function listGuestRequests(stayId) {
  return (await Request.forStay(stayId).orderBy('q.created_at', 'desc')).map(toGuestRequest);
}

/** A guest's request with a timeline that leaves out staff names and internal notes. */
export async function getGuestRequest(stayId, id) {
  const q = await Request.forStay(stayId).where('q.id', id).first();
  if (!q) throw notFound('Request');
  const timeline = [];
  for (const e of await Request.events(id)) {
    const by = e.actor_type === 'guest' ? 'you' : 'hotel';
    if (e.action === 'created') timeline.push({ event: 'created', by, at: e.created_at });
    else if (e.action === 'assigned') timeline.push({ event: 'assigned', by: 'hotel', at: e.created_at });
    else if (e.action === 'status_changed' && ['in_progress', 'done', 'cancelled'].includes(e.to_status)) timeline.push({ event: e.to_status, by, at: e.created_at });
  }
  return { ...toGuestRequest(q), timeline };
}

/** Guest cancels their own request; allowed while it is new or assigned. */
export async function cancelByGuest({ stayId, guestId }, id) {
  let assignee = null;
  let roomCleared = null;
  await transaction(async (trx) => {
    const req = await Request.lockForStay(id, stayId, trx);
    if (!req) throw notFound('Request');
    if (!['new', 'assigned'].includes(req.status)) {
      throw conflict(req.status === 'in_progress' ? 'A team member is already working on this request' : `This request is already ${req.status.replace('_', ' ')}`);
    }
    await Request.update(id, { status: 'cancelled' }, trx);
    await Request.addEvent({ requestId: id, actorType: 'guest', action: 'status_changed', fromStatus: req.status, toStatus: 'cancelled', note: 'Cancelled by guest' }, trx);
    roomCleared = await clearCleaningFlag(trx, id);
    await recordAudit({ actor: { type: 'guest', id: guestId }, action: 'request.cancel', entityType: 'request', entityId: id, roomId: req.room_id }, trx);
    assignee = req.assigned_to;
  });
  const request = await getRequest(id);
  bus.publish(EVENTS.REQUEST_UPDATED, request);
  bus.publish(EVENTS.ROOM_CHANGED, { roomId: request.room.id });
  if (roomCleared && roomCleared !== request.room.id) bus.publish(EVENTS.ROOM_CHANGED, { roomId: roomCleared });
  if (assignee) {
    emitToStaff(assignee, 'notification', { title: 'Request cancelled by guest', body: `Room ${request.room.number}: ${request.category}`, data: { type: 'request', requestId: id }, at: new Date().toISOString() });
  }
  return getGuestRequest(stayId, id);
}
