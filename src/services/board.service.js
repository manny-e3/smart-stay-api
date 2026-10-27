import * as Room from '../models/room.model.js';
import * as Stay from '../models/stay.model.js';
import * as Request from '../models/request.model.js';
import * as Alert from '../models/alert.model.js';
import * as Device from '../models/device.model.js';
import * as Feedback from '../models/feedback.model.js';
import { notFound } from '../utils/errors.js';
import { todayRange } from '../utils/time.js';
import { getSettings } from './settings.service.js';

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
const parseImages = (images) => (Array.isArray(images) ? images : typeof images === 'string' ? JSON.parse(images || '[]') : []);

/** Builds status summaries for all active rooms, or only for roomIds. */
export async function computeRoomSummaries({ roomIds, floor, roomType } = {}) {
  const rooms = await Room.listForBoard({ roomIds, floor, roomType });
  if (!rooms.length) return [];
  const ids = rooms.map((r) => r.id);

  const settings = await getSettings();
  const today = todayRange(settings.timezone);
  const now = new Date();
  const graceMs = settings.checkout_grace_minutes * 60_000;

  const [stays, arrivals, requests, alerts, offline] = await Promise.all([
    Stay.checkedInWithGuestForRooms(ids),
    Stay.reservedArrivingForRooms(ids, today.end, now),
    Request.openCountsByRoom(ids, OPEN_REQUEST_STATUSES),
    Alert.openCountsByRoom(ids),
    Device.offlineCountsByRoom(ids),
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
    const resolvedPrice = r.base_price != null ? Number(r.base_price) : r.type_base_price != null ? Number(r.type_base_price) : 0;
    const status = openAlerts ? 'alert' : openRequests ? 'request' : dnd ? 'dnd' : occupied ? 'occupied' : 'vacant';
    return {
      basePrice: resolvedPrice,
      price: resolvedPrice,
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
      images: parseImages(r.images),
    };
  });
}

/** The room board: rooms grouped by floor, most urgent first, with counts per status. */
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
 * Room detail panel. Guest contact details (phone, email) are only included for roles that
 * manage stays; other roles see the guest's first name and stay dates.
 */
export async function getRoomDetail(roomId, { includeContact = true } = {}) {
  const summary = await getRoomSummary(roomId);
  if (!summary) throw notFound('Room');

  const [stay, requests, alerts, devices, feedback] = await Promise.all([
    Stay.checkedInWithGuestForRoom(roomId),
    Request.openForRoom(roomId, OPEN_REQUEST_STATUSES),
    Alert.openForRoom(roomId),
    Device.detailForRoom(roomId),
    Feedback.listForRoom(roomId, 5),
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
