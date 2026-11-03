import * as Guest from '../models/guest.model.js';
import * as Stay from '../models/stay.model.js';
import * as Room from '../models/room.model.js';
import * as GuestAccess from '../models/guestAccess.model.js';
import { AppError, badRequest } from '../utils/errors.js';
import { lookupHash, normaliseCode } from '../utils/crypto.js';
import { getSettings } from './settings.service.js';
import { getRoomStatus } from './roomStatus.service.js';
import { keySummary } from './keys.service.js';
import { roomEcoState } from './controls.service.js';
import { createGuestRequest, getGuestRequest } from './requests.service.js';
import { submitFeedback } from './feedback.service.js';

/**
 * Guest app screens that are not a feature of their own: welcome info, home screen,
 * stay history, linking a booking to the account, push tokens, requests and feedback.
 * `guest` is req.guest: { guestId, stayId, roomId, roomNumber, sessionId }.
 */

/** Help and welcome screen content. Public. */
export async function getInfo() {
  const s = await getSettings();
  return { hotelName: s.hotel_name, receptionPhone: s.reception_phone || null, faqs: s.guest_faqs, privacyNotice: s.privacy_notice || null, quickLinks: s.guest_quick_links };
}

/** Everything the home screen shows. Works without a room (before check-in or between stays). */
export async function getHome({ stayId, roomId, guestId }) {
  const [stay, guest, room, settings, status, key, eco] = await Promise.all([
    stayId ? Stay.findById(stayId) : null,
    Guest.findById(guestId),
    roomId ? Room.findForGuest(roomId) : null,
    getSettings(),
    roomId ? getRoomStatus(roomId) : { dnd: false, cleaningRequested: false, cleaningRequestedAt: null },
    roomId ? keySummary(stayId, roomId) : null,
    roomId ? roomEcoState(roomId) : null,
  ]);
  return {
    hotel: { name: settings.hotel_name, receptionPhone: settings.reception_phone || null, acMinTemp: settings.ac_min_temp, acMaxTemp: settings.ac_max_temp },
    guest: guest ? { id: guest.id, firstName: guest.first_name, lastName: guest.last_name, email: guest.email, phone: guest.phone, language: guest.language } : { firstName: '', lastName: '' },
    stay: stay
      ? { reference: stay.reference, arrival: stay.check_in_at, departure: stay.check_out_at, checkedInAt: stay.checked_in_at, adults: stay.adults, children: stay.children }
      : { reference: null, arrival: null, departure: null, checkedInAt: null, adults: 1, children: 0 },
    room: room ? { number: room.number, floor: room.floor, roomType: room.room_type, imageUrl: room.image_url ?? null } : { number: 'Pending', floor: null, roomType: 'Allocated at check-in', imageUrl: null },
    roomStatus: status ? { dnd: status.dnd, cleaningRequested: status.cleaningRequested, cleaningRequestedAt: status.cleaningRequestedAt } : null,
    key,
    eco,
    quickLinks: settings.guest_quick_links,
  };
}

/** The guest's stays as primary guest, newest first. */
export async function getHistory(guestId) {
  const stays = await Stay.historyForGuest(guestId);
  return stays.map((s) => {
    const diffMs = Math.max(0, new Date(s.check_out_at).getTime() - new Date(s.check_in_at).getTime());
    return {
      id: s.id,
      reference: s.reference,
      suiteNumber: s.room_number || 'Unassigned',
      suiteType: s.room_type || 'Deluxe Suite',
      checkInDate: s.check_in_at,
      checkOutDate: s.check_out_at,
      nights: Math.max(1, Math.round(diffMs / 86_400_000)),
      status: s.status,
    };
  });
}

/** Reads a QR JSON payload or login link out of whichever field the app sent it in. */
function parseLinkInput(body) {
  let { bookingCode, reference, qrToken } = body;
  let stayId = null;
  const raw = (body.qrData || qrToken || bookingCode || reference || '').trim();
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const obj = JSON.parse(raw);
      if (obj.qrToken) qrToken = obj.qrToken;
      else if (obj.token) qrToken = obj.token;
      if (obj.accessCode) bookingCode = obj.accessCode;
      else if (obj.code) bookingCode = obj.code;
      if (obj.reference) reference = obj.reference;
      if (obj.stayId) stayId = obj.stayId;
    } catch {
      // Not JSON: use the fields as sent.
    }
  } else if (raw.includes('token=')) {
    const match = raw.match(/[?&]token=([^&]+)/);
    if (match && match[1]) qrToken = decodeURIComponent(match[1]);
  }
  return { bookingCode, reference, qrToken, stayId };
}

/**
 * Links a booking to the signed-in account by QR, booking code, or reference (+ last name).
 * Falls back to the guest's own checked-in stay. Returns { stayId, reference, roomNumber }.
 */
export async function linkBooking(guest, body) {
  const { bookingCode, reference, qrToken, stayId } = parseLinkInput(body);
  const { lastName } = body;

  let stay = stayId ? await Stay.findById(stayId) : null;
  if (!stay && qrToken) stay = await GuestAccess.findStayByLiveCode('qr', lookupHash(qrToken));
  if (!stay && bookingCode) stay = await GuestAccess.findStayByLiveCode('code', lookupHash(normaliseCode(bookingCode)));
  if (!stay && reference) {
    stay = await Stay.findByReference(reference);
    if (stay && lastName) {
      const names = await Stay.guestNamesOnStay(stay.id);
      if (!names.some((g) => g.last_name && g.last_name.toLowerCase().trim() === lastName.toLowerCase().trim())) stay = null;
    }
  }
  if (!stay && guest.guestId) stay = await Stay.findCheckedInForGuest(guest.guestId);

  if (!stay) throw new AppError(404, 'Booking not found with the provided details.', 'BOOKING_NOT_FOUND');
  if (stay.status === 'reserved') throw new AppError(403, 'Your booking is confirmed, but check-in has not started yet. Please check in at the front desk when you arrive.', 'NOT_CHECKED_IN');

  await GuestAccess.updateSession(guest.sessionId, { stay_id: stay.id });
  if (!(await Stay.isGuestOnStay(stay.id, guest.guestId))) await Stay.addGuest(stay.id, guest.guestId, false);

  const room = stay.room_id ? await Room.findNumber(stay.room_id) : null;
  return { stayId: stay.id, reference: stay.reference, roomNumber: room?.number || 'Pending' };
}

export function savePushToken(guest, { pushToken, platform }) {
  return Guest.savePushToken({ guestId: guest.guestId, stayId: guest.stayId, pushToken, platform });
}

/** Opens a request from the app. A preferred time must fall within the stay. */
export async function createRequest({ roomId, stayId, guestId }, body) {
  if (!roomId || !stayId) throw badRequest('You must have an active room check-in to request room services.');
  const { preferredAt } = body;
  if (preferredAt) {
    const stay = await Stay.findById(stayId);
    if (preferredAt < new Date(Date.now() - 5 * 60_000) || preferredAt > new Date(stay.check_out_at)) {
      throw badRequest('Choose a time between now and the end of your stay', [{ field: 'body.preferredAt', message: 'Outside your stay' }]);
    }
  }
  const request = await createGuestRequest({ roomId, stayId, guestId, ...body });
  return getGuestRequest(stayId, request.id);
}

/** Saves feedback. A guest between stays rates their most recent stay. */
export async function leaveFeedback({ roomId, stayId, guestId }, { markAsIssue, ...rest }, files) {
  if (!stayId) {
    const lastStay = await Stay.findNewestForGuest(guestId);
    if (lastStay) {
      stayId = lastStay.id;
      roomId = lastStay.room_id;
    }
  }
  const fb = await submitFeedback({ roomId, stayId, guestId, ...rest, isIssue: Boolean(markAsIssue), files });
  return { id: fb.id, photos: fb.photos, markedAsIssue: fb.isIssue };
}
