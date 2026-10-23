import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { db } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { lookupHash, normaliseCode } from '../../core/crypto.js';
import { AppError, unauthorized } from '../../core/errors.js';
import { getSettings } from '../settings/settings.service.js';

/**
 * Guest app sign-in. Three ways in:
 *   - booking code: the 8-character code given at check-in (card, email)
 *   - QR: the token inside the check-in QR code / login link
 *   - booking reference + last name of any guest on the booking (fallback)
 * Only checked-in stays can sign in. The token names the stay only; the room is looked up on
 * every request, so a moved guest follows their stay and a checked-out guest is locked out.
 */

const MAX_FAILURES = 10;
const LOCK_MINUTES = 15;

const normaliseName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const invalid = () => unauthorized('Those details do not match a current stay', 'INVALID_GUEST_CREDENTIALS');

async function registerFailure(stay) {
  const failures = stay.access_failures + 1;
  const lock = failures >= MAX_FAILURES;
  await db('stays')
    .where({ id: stay.id })
    .update({ access_failures: lock ? 0 : failures, access_locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : stay.access_locked_until });
  if (lock) await audit({ actor: { type: 'system' }, action: 'guest.access_locked', entityType: 'stay', entityId: stay.id, roomId: stay.room_id });
}

function assertNotLocked(stay) {
  if (stay.access_locked_until && new Date(stay.access_locked_until) > new Date()) {
    throw new AppError(423, 'Too many attempts. Please wait a few minutes or contact the front desk.', 'GUEST_ACCESS_LOCKED');
  }
}

/** Enforces the "phones per room" hotel setting (0 = no limit). */
async function assertPhoneLimit(stay) {
  const { phones_per_room: limit } = await getSettings();
  if (!limit) return;
  const row = await db('guest_sessions').where({ stay_id: stay.id }).whereNull('revoked_at').where('expires_at', '>', new Date()).count({ n: '*' }).first();
  if (Number(row.n) >= limit) {
    throw new AppError(409, `${limit} phone${limit === 1 ? ' is' : 's are'} already signed in for this room. Sign out on another phone or ask the front desk to reset access.`, 'DEVICE_LIMIT');
  }
}

async function startSession(stay, guestId, method, meta) {
  await assertPhoneLimit(stay);
  const expiresAt = new Date(Date.now() + env.auth.guestTokenDays * 86_400_000);
  const [sid] = await db('guest_sessions').insert({ stay_id: stay.id, guest_id: guestId, method, user_agent: meta.userAgent?.slice(0, 255) ?? null, ip: meta.ip ?? null, expires_at: expiresAt });
  await db('stays').where({ id: stay.id }).update({ access_failures: 0 });
  await audit({ actor: { type: 'guest', id: guestId }, action: 'guest.sign_in', entityType: 'stay', entityId: stay.id, roomId: stay.room_id, details: { method }, ip: meta.ip });
  const token = jwt.sign({ sub: guestId, sid, stay: stay.id }, env.auth.guestSecret, { audience: 'guest', expiresIn: `${env.auth.guestTokenDays}d` });
  return { token, expiresAt };
}

/** Booking code or QR token: both are looked up by their keyed hash among live codes. */
async function signInWithAccess(kind, value, meta) {
  const row = await db('guest_access_codes as c')
    .join('stays as s', 's.id', 'c.stay_id')
    .where({ 'c.kind': kind, 'c.lookup_hash': lookupHash(kind === 'code' ? normaliseCode(value) : value) })
    .whereNull('c.revoked_at')
    .first('s.*');
  if (!row || !['checked_in', 'reserved'].includes(row.status)) throw invalid();
  assertNotLocked(row);
  return startSession(row, row.guest_id, kind === 'code' ? 'booking_code' : 'qr', meta);
}

async function signInWithReference({ reference, lastName }, meta) {
  const stay = await db('stays').whereRaw('UPPER(reference) = ?', [reference.trim().toUpperCase()]).first();
  if (!stay) throw invalid();
  if (!['checked_in', 'reserved'].includes(stay.status)) throw invalid();
  assertNotLocked(stay);
  const guests = await db('stay_guests as sg').join('guests as g', 'g.id', 'sg.guest_id').where('sg.stay_id', stay.id).select('g.id', 'g.last_name');
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
  const row = await db('guest_sessions as gs')
    .join('stays as s', 's.id', 'gs.stay_id')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .where({ 'gs.id': payload.sid, 'gs.guest_id': payload.sub, 'gs.stay_id': payload.stay })
    .whereNull('gs.revoked_at')
    .first('gs.id as session_id', 's.id as stay_id', 's.status', 's.room_id', 'r.number as room_number', 'gs.guest_id');
  if (!row || !['checked_in', 'reserved'].includes(row.status)) throw unauthorized('Your stay has ended or this device was signed out', 'GUEST_SESSION_ENDED');
  return { guestId: row.guest_id, stayId: row.stay_id, roomId: row.room_id, roomNumber: row.room_number, sessionId: row.session_id };
}

/** Middleware: sets req.guest. */
export async function authenticateGuest(req, res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();
  req.guest = await resolveGuestToken(token);
  next();
}

export async function signOut(sessionId) {
  await db('guest_sessions').where({ id: sessionId }).update({ revoked_at: new Date() });
}
