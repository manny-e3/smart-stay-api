import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import * as Guest from '../models/guest.model.js';
import * as Stay from '../models/stay.model.js';
import * as Room from '../models/room.model.js';
import * as GuestAccess from '../models/guestAccess.model.js';
import { recordAudit } from './audit.service.js';
import { lookupHash, normaliseCode } from '../utils/crypto.js';
import { AppError, unauthorized } from '../utils/errors.js';
import { getSettings } from './settings.service.js';

/**
 * Guest app sign-in. Supports:
 *   - email + password (standard member account)
 *   - booking code: the 8-character code given at check-in (card, email)
 *   - QR: the token inside the check-in QR code / login link
 *   - booking reference + last name of any guest on the booking (fallback)
 *   - email only lookup for guests with reservations
 */

const MAX_FAILURES = 10;
const LOCK_MINUTES = 15;
const ACTIVE = ['checked_in', 'reserved'];

const normaliseName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const invalid = () => unauthorized('Those details do not match a current account or stay', 'INVALID_GUEST_CREDENTIALS');
const notCheckedIn = () => new AppError(403, 'Your reservation is confirmed, but check-in has not started yet. Please check in at the front desk when you arrive.', 'NOT_CHECKED_IN');

/** Counts a wrong last name against the stay; too many locks sign-in for a while. */
async function registerFailure(stay) {
  if (!stay) return;
  const failures = (stay.access_failures || 0) + 1;
  const lock = failures >= MAX_FAILURES;
  await Stay.update(stay.id, { access_failures: lock ? 0 : failures, access_locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : stay.access_locked_until });
  if (lock) await recordAudit({ actor: { type: 'system' }, action: 'guest.access_locked', entityType: 'stay', entityId: stay.id, roomId: stay.room_id });
}

function assertNotLocked(stay) {
  if (stay?.access_locked_until && new Date(stay.access_locked_until) > new Date()) {
    throw new AppError(423, 'Too many attempts. Please wait a few minutes or contact the front desk.', 'GUEST_ACCESS_LOCKED');
  }
}

/** Enforces the "phones per room" hotel setting (0 = no limit). */
async function assertPhoneLimit(stay) {
  if (!stay) return;
  const { phones_per_room: limit } = await getSettings();
  if (!limit) return;
  if ((await GuestAccess.countLiveSessions(stay.id)) >= limit) {
    throw new AppError(409, `${limit} phone${limit === 1 ? ' is' : 's are'} already signed in for this room. Sign out on another phone or ask the front desk to reset access.`, 'DEVICE_LIMIT');
  }
}

/** Creates a guest session and returns its token. stay may be null for an account without a current stay. */
export async function startSession(stay, guestId, method, meta) {
  if (stay) {
    // A password sign-in replaces the guest's previous sessions.
    if (method === 'password' && guestId) await GuestAccess.revokeSessionsForGuest(guestId);
    await assertPhoneLimit(stay);
  }
  const expiresAt = new Date(Date.now() + env.auth.guestTokenDays * 86_400_000);
  const sid = await GuestAccess.createSession({
    stay_id: stay?.id || null,
    guest_id: guestId,
    method,
    user_agent: meta.userAgent?.slice(0, 255) ?? null,
    ip: meta.ip ?? null,
    expires_at: expiresAt,
  });
  if (stay) {
    await Stay.update(stay.id, { access_failures: 0 });
    await recordAudit({ actor: { type: 'guest', id: guestId }, action: 'guest.sign_in', entityType: 'stay', entityId: stay.id, roomId: stay.room_id, details: { method }, ip: meta.ip });
  } else {
    await recordAudit({ actor: { type: 'guest', id: guestId }, action: 'guest.sign_in', entityType: 'guest', entityId: guestId, details: { method }, ip: meta.ip });
  }
  const token = jwt.sign({ sub: guestId, sid, stay: stay?.id || null }, env.auth.guestSecret, { audience: 'guest', expiresIn: `${env.auth.guestTokenDays}d` });
  return { token, expiresAt };
}

/** Booking code or QR token: both are looked up by their keyed hash among live codes. */
async function signInWithAccess(kind, value, meta) {
  const stay = await GuestAccess.findStayByLiveCode(kind, lookupHash(kind === 'code' ? normaliseCode(value) : value));
  if (!stay) throw invalid();
  if (stay.status === 'reserved') throw notCheckedIn();
  if (stay.status !== 'checked_in') throw invalid();
  assertNotLocked(stay);
  return startSession(stay, stay.guest_id, kind === 'code' ? 'booking_code' : 'qr', meta);
}

export async function signInWithEmailAndPassword({ email, password }, meta) {
  const guest = await Guest.findByEmail(email);
  if (!guest) throw invalid();
  if (!guest.password_hash) throw unauthorized('Please set a password or use your booking details to sign in', 'PASSWORD_NOT_SET');
  if (!(await bcrypt.compare(password, guest.password_hash))) throw invalid();

  const stay = await Stay.findLatestForGuest(guest.id);
  if (stay && ACTIVE.includes(stay.status)) {
    assertNotLocked(stay);
    return startSession(stay, guest.id, 'password', meta);
  }
  return startSession(stay || null, guest.id, 'password', meta);
}

async function signInWithEmail({ email, lastName }, meta) {
  const guest = await Guest.findByEmail(email);
  if (!guest) throw invalid();
  if (lastName && normaliseName(guest.last_name) !== normaliseName(lastName)) throw invalid();
  const stay = await Stay.findLatestForGuest(guest.id);
  if (!stay) throw invalid();
  assertNotLocked(stay);
  return startSession(stay, guest.id, 'email', meta);
}

async function signInWithReference({ reference, lastName }, meta) {
  const stay = await Stay.findByReference(reference);
  if (!stay) throw invalid();
  if (stay.status === 'reserved') throw notCheckedIn();
  if (stay.status !== 'checked_in') throw invalid();
  assertNotLocked(stay);
  const guests = await Stay.guestNamesOnStay(stay.id);
  const match = guests.find((g) => g.last_name && normaliseName(g.last_name) === normaliseName(lastName));
  if (!match) {
    await registerFailure(stay);
    throw invalid();
  }
  return startSession(stay, match.id, 'booking_reference', meta);
}

export function signIn(body, meta) {
  if (body.bookingCode) return signInWithAccess('code', body.bookingCode, meta);
  if (body.qrToken) return signInWithAccess('qr', body.qrToken, meta);
  if (body.email && body.password) return signInWithEmailAndPassword(body, meta);
  if (body.email) return signInWithEmail(body, meta);
  return signInWithReference(body, meta);
}

/** Verifies a guest token and returns { guestId, stayId, roomId, roomNumber, sessionId }. */
export async function resolveGuestToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.auth.guestSecret, { audience: 'guest' });
  } catch {
    throw unauthorized('Invalid or expired guest token', 'GUEST_TOKEN_INVALID');
  }

  const session = await GuestAccess.findSession(payload.sid);

  // A registered account (password) follows the guest across stays and stays usable between them.
  if (session && session.method === 'password' && payload.sub) {
    const activeStay = await Stay.findActiveForGuestWithRoom(payload.sub);
    if (activeStay) {
      if (session.revoked_at || session.stay_id !== activeStay.stay_id) {
        await GuestAccess.updateSession(session.id, { revoked_at: null, stay_id: activeStay.stay_id });
        session.revoked_at = null;
        session.stay_id = activeStay.stay_id;
      }
    } else if (session.revoked_at) {
      // Re-enable the account session so the guest can view their profile and history.
      await GuestAccess.updateSession(session.id, { revoked_at: null, stay_id: null });
      session.revoked_at = null;
      session.stay_id = null;
    }
  }

  if (!session || session.revoked_at) throw unauthorized('Your stay has ended or this device was signed out', 'GUEST_SESSION_ENDED');

  let stayId = session.stay_id;
  let stay = stayId ? await Stay.findById(stayId) : null;

  // The session's stay has ended: an account moves to another active stay, a one-stay session ends.
  if (!stay || !ACTIVE.includes(stay.status)) {
    if (session.method !== 'password' || !session.guest_id) throw unauthorized('Your stay has ended or this device was signed out', 'GUEST_SESSION_ENDED');
    const activeStay = await Stay.findActiveForGuestWithRoom(session.guest_id);
    stayId = activeStay?.stay_id ?? null;
    stay = activeStay ?? null;
    await GuestAccess.updateSession(session.id, { stay_id: stayId });
  }

  const room = stay?.room_id ? await Room.findById(stay.room_id) : null;
  return {
    guestId: session.guest_id,
    stayId: stayId || null,
    roomId: room?.id || null,
    roomNumber: room?.number || null,
    sessionId: session.id,
  };
}

export async function signOut(sessionId) {
  await GuestAccess.revokeSession(sessionId);
}
