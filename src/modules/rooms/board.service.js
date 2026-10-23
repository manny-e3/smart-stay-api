import { db } from '../../config/db.js';
import { notFound } from '../../core/errors.js';
import { todayRange } from '../../core/time.js';
import { getSettings } from '../settings/settings.service.js';

/**
 * Room status for the board, highest priority first. A room shows the first status that applies:
 *   alert    - an open alert (device fault, offline, guest issue)
 *   request  - an open guest request
 *   dnd      - do not disturb is on
 *   occupied - a guest is checked in
 *   vacant   - nobody checked in
 */
export const ROOM_STATUSES = ['alert', 'request', 'dnd', 'occupied', 'vacant'];
export const OPEN_REQUEST_STATUSES = ['new', 'assigned', 'in_progress'];
const SEVERITY = ['info', 'warning', 'critical'];

const byNumber = (a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true });

/** Builds status summaries for all active rooms, or only for roomIds. */
export async function computeRoomSummaries({ roomIds, floor, roomType } = {}) {
  const roomsQ = db('rooms as r')
    .join('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('room_types as t', 't.id', 'r.room_type_id')
    .where('r.is_active', true)
    .select('r.id', 'r.number', 'r.dnd', 'r.dnd_updated_at', 'r.cleaning_requested', 'r.cleaning_requested_at', 'r.image_url as imageUrl', 'r.images', 'f.id as floor_id', 'f.number as floor_number', 'f.name as floor_name', 't.id as type_id', 't.name as type_name');
  if (roomIds) roomsQ.whereIn('r.id', roomIds);
  if (floor?.length) roomsQ.whereIn('f.number', floor);
  if (roomType?.length) roomsQ.whereIn('t.name', roomType);
  const rooms = await roomsQ;
  if (!rooms.length) return [];
  const ids = rooms.map((r) => r.id);

  const settings = await getSettings();
  const today = todayRange(settings.timezone);
  const now = new Date();
  const graceMs = settings.checkout_grace_minutes * 60_000;

  const [stays, arrivals, requests, alerts, offline] = await Promise.all([
    db('stays as s')
      .join('guests as g', 'g.id', 's.guest_id')
      .whereIn('s.room_id', ids)
      .where('s.status', 'checked_in')
      .select('s.id', 's.room_id', 's.check_in_at', 's.check_out_at', 'g.first_name', 'g.last_name'),
    db('stays')
      .whereIn('room_id', ids)
      .where('status', 'reserved')
      .where('check_in_at', '<', today.end)
      .where('check_out_at', '>', now)
      .select('id', 'room_id', 'check_in_at'),
    db('requests')
      .whereIn('room_id', ids)
      .whereIn('status', OPEN_REQUEST_STATUSES)
      .groupBy('room_id')
      .select('room_id')
      .count({ open: '*' })
      .select(db.raw('SUM(escalated_at IS NOT NULL) AS escalated'))
      .min({ oldest: 'created_at' }),
    db('alerts')
      .whereIn('room_id', ids)
      .where('status', 'open')
      .groupBy('room_id')
      .select('room_id')
      .count({ open: '*' })
      .select(db.raw("MAX(FIELD(severity, 'info', 'warning', 'critical')) AS sev")),
    db('device_states as ds')
      .join('devices as d', 'd.id', 'ds.device_id')
      .whereIn('d.room_id', ids)
      .where({ 'd.is_active': true, 'ds.online': false })
      .groupBy('d.room_id')
      .select('d.room_id')
      .count({ n: '*' }),
  ]);

  const stayBy = new Map(stays.map((s) => [s.room_id, s]));
  const arrivalBy = new Map(arrivals.map((a) => [a.room_id, a]));
  const reqBy = new Map(requests.map((r) => [r.room_id, r]));
  const alertBy = new Map(alerts.map((a) => [a.room_id, a]));
  const offBy = new Map(offline.map((o) => [o.room_id, Number(o.n)]));

  return rooms.map((r) => {
    const stay = stayBy.get(r.id);
    const req = reqBy.get(r.id);
    const al = alertBy.get(r.id);
    const openRequests = Number(req?.open ?? 0);
    const openAlerts = Number(al?.open ?? 0);
    const occupied = Boolean(stay);
    const dnd = occupied && Boolean(r.dnd);
    const status = openAlerts ? 'alert' : openRequests ? 'request' : dnd ? 'dnd' : occupied ? 'occupied' : 'vacant';
    return {
      id: r.id,
      number: r.number,
      floor: { id: r.floor_id, number: r.floor_number, name: r.floor_name },
      roomType: r.type_id ? { id: r.type_id, name: r.type_name } : null,
      status,
      priority: ROOM_STATUSES.indexOf(status),
      occupied,
      dnd,
      guest: stay ? { stayId: stay.id, name: [stay.first_name, stay.last_name].filter(Boolean).join(' '), checkOutAt: stay.check_out_at } : null,
      arrivalToday: !stay && arrivalBy.has(r.id),
      departureToday: Boolean(stay && new Date(stay.check_out_at) >= today.start && new Date(stay.check_out_at) < today.end),
      checkOutOverdue: Boolean(stay && new Date(stay.check_out_at).getTime() + graceMs < now.getTime()),
      openRequests,
      escalatedRequests: Number(req?.escalated ?? 0),
      oldestRequestAt: req?.oldest ?? null,
      openAlerts,
      alertSeverity: al ? SEVERITY[Number(al.sev) - 1] : null,
      devicesOffline: offBy.get(r.id) ?? 0,
      imageUrl: r.imageUrl || null,
      cleaningRequested: Boolean(r.cleaning_requested),
      cleaningRequestedAt: r.cleaning_requested_at ?? null,
      images: Array.isArray(r.images) ? r.images : typeof r.images === 'string' ? JSON.parse(r.images || '[]') : [],
    };
  });
}

export async function getBoard({ floor, status, roomType } = {}) {
  const all = await computeRoomSummaries({ floor, roomType });
  const counts = Object.fromEntries(ROOM_STATUSES.map((s) => [s, 0]));
  for (const r of all) counts[r.status]++;
  const rooms = status?.length ? all.filter((r) => status.includes(r.status)) : all;

  const floors = new Map();
  for (const r of rooms) {
    if (!floors.has(r.floor.id)) floors.set(r.floor.id, { ...r.floor, rooms: [] });
    floors.get(r.floor.id).rooms.push(r);
  }
  const sortRooms = (a, b) => a.priority - b.priority || b.escalatedRequests - a.escalatedRequests || byNumber(a, b);
  return {
    counts: { ...counts, total: all.length },
    statuses: ROOM_STATUSES,
    floors: [...floors.values()].sort((a, b) => a.number - b.number).map((f) => ({ ...f, rooms: f.rooms.sort(sortRooms) })),
    generatedAt: new Date().toISOString(),
  };
}

export async function getRoomSummary(roomId) {
  const [summary] = await computeRoomSummaries({ roomIds: [roomId] });
  return summary ?? null;
}

/**
 * Room detail. Guest contact details (phone, email) are only included for roles that
 * manage stays; other roles see the guest's first name and stay dates.
 */
export async function getRoomDetail(roomId, { includeContact = true } = {}) {
  const summary = await getRoomSummary(roomId);
  if (!summary) throw notFound('Room');

  const [stay, requests, alerts, devices, feedback] = await Promise.all([
    db('stays as s')
      .join('guests as g', 'g.id', 's.guest_id')
      .where({ 's.room_id': roomId, 's.status': 'checked_in' })
      .first('s.id', 's.reference', 's.check_in_at', 's.check_out_at', 's.checked_in_at', 's.adults', 's.children', 'g.id as guest_id', 'g.first_name', 'g.last_name', 'g.phone', 'g.email', 'g.language', 'g.vip'),
    db('requests as q')
      .leftJoin('staff as st', 'st.id', 'q.assigned_to')
      .where('q.room_id', roomId)
      .whereIn('q.status', OPEN_REQUEST_STATUSES)
      .orderBy('q.created_at')
      .select('q.id', 'q.category', 'q.description', 'q.priority', 'q.status', 'q.created_at', 'q.escalated_at', 'st.id as assignee_id', 'st.name as assignee_name'),
    db('alerts as a')
      .leftJoin('devices as d', 'd.id', 'a.device_id')
      .where({ 'a.room_id': roomId, 'a.status': 'open' })
      .orderBy('a.last_seen_at', 'desc')
      .select('a.id', 'a.type', 'a.severity', 'a.title', 'a.message', 'a.occurrence_count', 'a.last_seen_at', 'd.name as device_name'),
    db('devices as d')
      .join('adapters as ad', 'ad.id', 'd.adapter_id')
      .leftJoin('device_states as ds', 'ds.device_id', 'd.id')
      .where({ 'd.room_id': roomId, 'd.is_active': true })
      .orderBy(['d.type', 'd.name'])
      .select('d.id', 'd.type', 'd.name', 'd.external_id', 'ad.name as adapter_name', 'ad.status as adapter_status', 'ds.online', 'ds.state', 'ds.last_seen_at'),
    db('feedback').where({ room_id: roomId }).orderBy('created_at', 'desc').limit(5).select('id', 'rating', 'comment', 'created_at'),
  ]);

  return {
    ...summary,
    stay: stay
      ? {
          id: stay.id,
          checkInAt: stay.check_in_at,
          checkOutAt: stay.check_out_at,
          checkedInAt: stay.checked_in_at,
          adults: stay.adults,
          children: stay.children,
          ...(includeContact ? { reference: stay.reference } : {}),
          guest: includeContact
            ? { id: stay.guest_id, firstName: stay.first_name, lastName: stay.last_name, phone: stay.phone, email: stay.email, language: stay.language, vip: Boolean(stay.vip) }
            : { id: stay.guest_id, firstName: stay.first_name, language: stay.language, vip: Boolean(stay.vip) },
        }
      : null,
    requests: requests.map((q) => ({
      id: q.id, category: q.category, description: q.description, priority: q.priority, status: q.status,
      createdAt: q.created_at, escalated: Boolean(q.escalated_at), assignee: q.assignee_id ? { id: q.assignee_id, name: q.assignee_name } : null,
    })),
    alerts: alerts.map((a) => ({ id: a.id, type: a.type, severity: a.severity, title: a.title, message: a.message, occurrenceCount: a.occurrence_count, lastSeenAt: a.last_seen_at, deviceName: a.device_name })),
    devices: devices.map((d) => ({
      id: d.id, type: d.type, name: d.name, externalId: d.external_id, adapter: d.adapter_name, adapterStatus: d.adapter_status,
      online: d.online ?? null, state: d.state ?? {}, lastSeenAt: d.last_seen_at ?? null,
    })),
    recentFeedback: feedback.map((f) => ({ id: f.id, rating: f.rating, comment: f.comment, createdAt: f.created_at })),
  };
}
