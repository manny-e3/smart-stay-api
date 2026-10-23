import { db, paginate, json } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { bus, EVENTS } from '../../core/events.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { can, rolesFor } from '../../core/permissions.js';
import { notifyStaff, pushToGuest } from '../../core/notifier.js';
import { emitToStaff } from '../../core/sockets.js';
import { getSettings } from '../settings/settings.service.js';

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

const COLUMNS = [
  'q.*',
  'r.number as room_number',
  'f.number as floor_number',
  'st.name as assignee_name',
  'cb.name as created_by_name',
  'g.first_name as guest_first_name',
  'g.last_name as guest_last_name',
];

const baseQuery = () =>
  db('requests as q')
    .join('rooms as r', 'r.id', 'q.room_id')
    .join('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('staff as st', 'st.id', 'q.assigned_to')
    .leftJoin('staff as cb', 'cb.id', 'q.created_by_staff_id')
    .leftJoin('guests as g', 'g.id', 'q.guest_id');

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

const loadRequest = async (id) => {
  const q = await baseQuery().where('q.id', id).first(COLUMNS);
  return q ? toRequest(q) : null;
};

export async function listRequests({ status, category, priority, roomId, assignedTo, unassigned, escalated, from, to, page, limit }) {
  const q = baseQuery().select(COLUMNS);
  if (status?.length) q.whereIn('q.status', status);
  if (category?.length) q.whereIn('q.category', category);
  if (priority?.length) q.whereIn('q.priority', priority);
  if (roomId) q.where('q.room_id', roomId);
  if (assignedTo) q.where('q.assigned_to', assignedTo);
  if (unassigned) q.whereNull('q.assigned_to');
  if (escalated !== undefined) escalated ? q.whereNotNull('q.escalated_at') : q.whereNull('q.escalated_at');
  if (from) q.where('q.created_at', '>=', from);
  if (to) q.where('q.created_at', '<=', to);
  q.orderByRaw("q.escalated_at IS NULL, FIELD(q.priority, 'urgent', 'high', 'normal'), q.created_at ASC");
  const result = await paginate(q, { page, limit });

  const counts = await db('requests').whereIn('status', OPEN_STATUSES).select('status').count({ n: '*' }).groupBy('status');
  return {
    ...result,
    items: result.items.map(toRequest),
    openCounts: Object.fromEntries(OPEN_STATUSES.map((s) => [s, Number(counts.find((c) => c.status === s)?.n ?? 0)])),
  };
}

/** Active staff whose role handles requests, with how many open requests each has. */
export async function listAssignees() {
  const rows = await db('staff as s')
    .leftJoin('requests as q', (j) => j.on('q.assigned_to', 's.id').onIn('q.status', OPEN_STATUSES))
    .where('s.is_active', true)
    .whereIn('s.role', rolesFor('requests:write'))
    .groupBy('s.id', 's.name', 's.role')
    .orderBy('s.name')
    .select('s.id', 's.name', 's.role')
    .count({ open: 'q.id' });
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, openRequests: Number(r.open) }));
}

export async function getRequest(id) {
  const request = await loadRequest(id);
  if (!request) throw notFound('Request');
  const history = await db('request_events as e')
    .leftJoin('staff as s', 's.id', 'e.staff_id')
    .where('e.request_id', id)
    .orderBy('e.created_at')
    .orderBy('e.id')
    .select('e.id', 'e.action', 'e.from_status', 'e.to_status', 'e.note', 'e.data', 'e.actor_type', 'e.created_at', 's.id as staff_id', 's.name as staff_name');
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

async function activeStay(trx, roomId) {
  return trx('stays').where({ room_id: roomId, status: 'checked_in' }).orderBy('check_in_at', 'desc').first('id', 'guest_id');
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
  const room = await db('rooms').where({ id: roomId, is_active: true }).first('id');
  if (!room) throw badRequest('Room not found or inactive');
  const id = await db.transaction(async (trx) => {
    const stay = await activeStay(trx, roomId);
    const [newId] = await trx('requests').insert({
      room_id: roomId, stay_id: stay?.id ?? null, guest_id: stay?.guest_id ?? null, category, description, priority,
      preferred_at: preferredAt, status: 'new', source: 'staff', created_by_staff_id: actor.id,
    });
    await trx('request_events').insert({ request_id: newId, staff_id: actor.id, actor_type: 'staff', action: 'created', to_status: 'new', data: json({ onBehalfOfGuest: true }) });
    await audit({ actor: { type: 'staff', id: actor.id }, action: 'request.create', entityType: 'request', entityId: newId, roomId, details: { category, priority }, ip: actor.ip }, trx);
    return newId;
  });
  const request = await loadRequest(id);
  await afterCreate(request);
  return request;
}

/** Request created by a guest in the guest app. Exported for the guest section of the API. */
/** Inserts a guest request inside a caller's transaction. Call announceRequest(id) after commit. */
export async function insertGuestRequest(trx, { roomId, stayId, guestId, category, description = null, priority = 'normal', preferredAt = null }) {
  const [newId] = await trx('requests').insert({ room_id: roomId, stay_id: stayId, guest_id: guestId, category, description, priority, preferred_at: preferredAt, status: 'new', source: 'guest' });
  await trx('request_events').insert({ request_id: newId, actor_type: 'guest', action: 'created', to_status: 'new' });
  return newId;
}

/** Live update and staff notification for a newly created request. */
export async function announceRequest(id) {
  const request = await loadRequest(id);
  await afterCreate(request);
  return request;
}

/** Request created by a guest in the guest app. */
export async function createGuestRequest(input) {
  const id = await db.transaction((trx) => insertGuestRequest(trx, input));
  return announceRequest(id);
}

/** Clears the room's "cleaning requested" flag when its housekeeping request ends. */
async function clearCleaningFlag(trx, requestId) {
  const room = await trx('rooms').where({ cleaning_request_id: requestId }).first('id');
  if (!room) return null;
  await trx('rooms').where({ id: room.id }).update({ cleaning_requested: false, cleaning_requested_at: null, cleaning_request_id: null });
  return room.id;
}

/* ---------------------------------------------------------- guest view */

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

const guestRequestQuery = (stayId) =>
  db('requests as q').join('rooms as r', 'r.id', 'q.room_id').where('q.stay_id', stayId).select('q.*', 'r.number as room_number');

export async function listGuestRequests(stayId) {
  return (await guestRequestQuery(stayId).orderBy('q.created_at', 'desc')).map(toGuestRequest);
}

/** A guest's request with a timeline that leaves out staff names and internal notes. */
export async function getGuestRequest(stayId, id) {
  const q = await guestRequestQuery(stayId).where('q.id', id).first();
  if (!q) throw notFound('Request');
  const events = await db('request_events').where({ request_id: id }).orderBy('created_at').orderBy('id');
  const timeline = [];
  for (const e of events) {
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
  await db.transaction(async (trx) => {
    const req = await trx('requests').where({ id, stay_id: stayId }).forUpdate().first();
    if (!req) throw notFound('Request');
    if (!['new', 'assigned'].includes(req.status)) {
      throw conflict(req.status === 'in_progress' ? 'A team member is already working on this request' : `This request is already ${req.status.replace('_', ' ')}`);
    }
    await trx('requests').where({ id }).update({ status: 'cancelled' });
    await trx('request_events').insert({ request_id: id, actor_type: 'guest', action: 'status_changed', from_status: req.status, to_status: 'cancelled', note: 'Cancelled by guest' });
    roomCleared = await clearCleaningFlag(trx, id);
    await audit({ actor: { type: 'guest', id: guestId }, action: 'request.cancel', entityType: 'request', entityId: id, roomId: req.room_id }, trx);
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

/** Assigns, changes status or priority, or adds a note. Every change is kept in the history. */
export async function updateRequest(id, input, actor) {
  const { status, assignedTo, priority, note } = input;

  const outcome = await db.transaction(async (trx) => {
    const current = await trx('requests').where({ id }).forUpdate().first();
    if (!current) throw notFound('Request');
    if (!OPEN_STATUSES.includes(current.status) && (status || assignedTo !== undefined || priority)) {
      throw badRequest(`Request is ${current.status} and can no longer be changed`);
    }

    const patch = {};
    const events = [];
    let nextStatus = current.status;

    if (assignedTo !== undefined && assignedTo !== current.assigned_to) {
      if (assignedTo !== null) {
        const assignee = await trx('staff').where({ id: assignedTo, is_active: true }).first('id', 'name', 'role');
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
      events.push({ action: 'status_changed', from_status: current.status, to_status: nextStatus });
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

    if (Object.keys(patch).length) await trx('requests').where({ id }).update(patch);
    if (patch.status === 'done' || patch.status === 'cancelled') await clearCleaningFlag(trx, id);
    for (const e of events) {
      await trx('request_events').insert({ request_id: id, staff_id: actor.id, actor_type: 'staff', action: e.action, from_status: e.from_status ?? null, to_status: e.to_status ?? null, note: e.note ?? null, data: json(e.data) });
    }
    await audit({ actor: { type: 'staff', id: actor.id }, action: 'request.update', entityType: 'request', entityId: id, roomId: current.room_id, details: { ...input }, ip: actor.ip }, trx);
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

/** Marks requests that have waited longer than the escalation time. Run by a background job. */
export async function escalateOverdue(now = new Date()) {
  const { escalation_minutes: minutes } = await getSettings();
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const overdue = await db('requests').whereIn('status', ['new', 'assigned']).whereNull('escalated_at').where('created_at', '<=', cutoff).select('id');
  const escalated = [];
  for (const { id } of overdue) {
    const updated = await db.transaction(async (trx) => {
      const n = await trx('requests').where({ id }).whereNull('escalated_at').whereIn('status', ['new', 'assigned']).update({ escalated_at: now });
      if (!n) return false;
      await trx('request_events').insert({ request_id: id, actor_type: 'system', action: 'escalated', data: json({ afterMinutes: minutes }) });
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
