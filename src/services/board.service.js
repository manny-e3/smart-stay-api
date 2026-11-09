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

  const [stays, arrivals, requests, alerts, offline, roomDevices] = await Promise.all([
    Stay.checkedInWithGuestForRooms(ids),
    Stay.reservedArrivingForRooms(ids, today.end, now),
    Request.openCountsByRoom(ids, OPEN_REQUEST_STATUSES),
    Alert.openCountsByRoom(ids),
    Device.offlineCountsByRoom(ids),
    // 'tv' and 'other' (fridge) are needed for the room-controller relay tiles.
    Device.inRoomsOfTypes(ids, ['sensor', 'thermostat', 'meter', 'light', 'tv', 'other']),
  ]);

  const stayBy = new Map(stays.map((s) => [s.room_id, s]));
  const arrivalBy = new Map(arrivals.map((a) => [a.room_id, a]));
  const reqBy = new Map(requests.map((r) => [r.room_id, r]));
  const alertBy = new Map(alerts.map((a) => [a.room_id, a]));
  const offBy = new Map(offline.map((o) => [o.room_id, Number(o.n)]));

  const devicesByRoom = new Map();
  for (const d of roomDevices) {
    if (!devicesByRoom.has(d.room_id)) devicesByRoom.set(d.room_id, []);
    devicesByRoom.get(d.room_id).push(d);
  }

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

    const devs = devicesByRoom.get(r.id) || [];
    const bme = devs.find((d) => d.external_id?.includes('bme680')) ||
                devs.find((d) => d.type === 'sensor' && d.state?.temperature !== undefined) ||
                devs.find((d) => d.type === 'thermostat');
    const meter = devs.find((d) => d.type === 'meter' && (d.state?.energy !== undefined || d.state?.power !== undefined)) ||
                  devs.find((d) => d.type === 'meter');
    const mq = devs.find((d) => d.external_id?.includes('mq2') || (d.type === 'sensor' && d.name?.toLowerCase().includes('smoke')));
    const lights = devs.filter((d) => d.type === 'light');
    // Prefer the exact relay devices the ESP32 hub reports on (`light-106`, `ac-106`, ...). Older or
    // manually added duplicates (`thermostat-ac-106`, `light-bedside-106`) would otherwise win and
    // make the tiles show stale state.
    const byExt = (key) => devs.find((d) => d.external_id === `${key}-${r.number}`);
    const relayLight = byExt('light');
    const acDev = byExt('ac') || devs.find((d) => d.type === 'thermostat' || d.external_id?.includes('ac'));
    const tvDev = byExt('tv') || devs.find((d) => d.type === 'tv' || d.external_id?.includes('tv'));
    const fridgeDev = byExt('fridge') || devs.find((d) => d.external_id?.includes('fridge') || d.name?.toLowerCase().includes('fridge'));

    const bmeState = typeof bme?.state === 'string' ? JSON.parse(bme.state) : (bme?.state || {});
    const meterState = typeof meter?.state === 'string' ? JSON.parse(meter.state) : (meter?.state || {});
    const mqState = typeof mq?.state === 'string' ? JSON.parse(mq.state) : (mq?.state || {});
    const acState = typeof acDev?.state === 'string' ? JSON.parse(acDev.state) : (acDev?.state || {});
    const tvState = typeof tvDev?.state === 'string' ? JSON.parse(tvDev.state) : (tvDev?.state || {});
    const fridgeState = typeof fridgeDev?.state === 'string' ? JSON.parse(fridgeDev.state) : (fridgeDev?.state || {});

    const temp = bmeState.temperature != null ? Number(bmeState.temperature) : null;
    const humidity = bmeState.humidity != null ? Number(bmeState.humidity) : null;
    const pressure = bmeState.pressure != null ? Number(bmeState.pressure) : null;
    const iaq = bmeState.airQuality || null;
    const energy24h = meterState.energy != null ? Number((meterState.energy / 1000).toFixed(1)) : null;
    const power = meterState.power != null ? Number(meterState.power) : null;
    const voltage = meterState.voltage != null ? Number(meterState.voltage) : null;
    const current = meterState.current != null ? Number(meterState.current) : null;
    const smokeValue = mqState.smokeValue != null ? Number(mqState.smokeValue) : null;
    const smokeAlert = Boolean(mqState.smokeAlert || (smokeValue && smokeValue > 1800));

    let hubDeviceId = null;
    let maxLastSeenMs = 0;
    for (const d of devs) {
      const caps = typeof d.capabilities === 'string' ? JSON.parse(d.capabilities || '{}') : (d.capabilities || {});
      if (caps.hubDeviceId) {
        hubDeviceId = caps.hubDeviceId;
      }
      if (d.last_seen_at) {
        const t = new Date(d.last_seen_at).getTime();
        if (t > maxLastSeenMs) {
          maxLastSeenMs = t;
        }
      }
    }

    const isHubLinked = Boolean(hubDeviceId);
    // Real hardware heartbeat check (90s window; ESP32 firmware pushes every 5s)
    const HEARTBEAT_TIMEOUT_MS = 90 * 1000;
    const isHubOnline = Boolean(
      isHubLinked &&
      maxLastSeenMs > 0 &&
      (Date.now() - maxLastSeenMs <= HEARTBEAT_TIMEOUT_MS)
    );

    const lightOn = (l) => {
      const st = typeof l.state === 'string' ? JSON.parse(l.state) : (l.state || {});
      return Boolean(st.on);
    };
    // With an ESP32 hub the Light tile mirrors the light relay itself; otherwise "any light on".
    const anyLightOn = relayLight ? lightOn(relayLight) : lights.some(lightOn);
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
      isLinked: isHubLinked,
      isOnline: isHubOnline,
      hubOnline: isHubOnline,
      temp: isHubOnline ? temp : null,
      humidity: isHubOnline ? humidity : null,
      pressure: isHubOnline ? pressure : null,
      iaq: isHubOnline ? iaq : null,
      energy24h: isHubOnline ? energy24h : null,
      power: isHubOnline ? power : null,
      voltage: isHubOnline ? voltage : null,
      current: isHubOnline ? current : null,
      smokeValue: isHubOnline ? smokeValue : null,
      smokeAlert: isHubOnline ? smokeAlert : false,
      hubDeviceId,
      devices: {
        light: isHubOnline ? anyLightOn : false,
        ac: isHubOnline ? (acState.power ?? acState.on ?? false) : false,
        tv: isHubOnline ? (tvState.power ?? tvState.on ?? false) : false,
        fridge: isHubOnline ? (fridgeState.on ?? false) : false,
      },
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
    devices: devices.map((d) => {
      const caps = typeof d.capabilities === 'string' ? JSON.parse(d.capabilities || '{}') : (d.capabilities || {});
      const isHubLinked = Boolean(summary.hubDeviceId || caps.hubDeviceId);
      const isHubOnline = Boolean(summary.hubOnline);
      const isDevOnline = isHubOnline && (d.online === 1 || d.online === true);
      return {
        id: d.id,
        type: d.type,
        name: d.name,
        externalId: d.external_id,
        adapter: d.adapter_name,
        adapterStatus: isHubOnline ? d.adapter_status : 'offline',
        online: isDevOnline,
        isActive: isHubOnline ? (d.is_active !== false) : false,
        state: isHubOnline ? (d.state ?? {}) : {},
        lastSeenAt: isHubOnline ? (d.last_seen_at ?? null) : null,
        capabilities: caps,
      };
    }),
    recentFeedback: feedback.map((f) => ({ id: f.id, rating: f.rating, comment: f.comment, createdAt: f.created_at })),
  };
}
