import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { db } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { lookupHash, normaliseCode } from '../../core/crypto.js';
import { AppError, unauthorized } from '../../core/errors.js';
import { getSettings } from '../settings/settings.service.js';

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

const normaliseName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const invalid = () => unauthorized('Those details do not match a current account or stay', 'INVALID_GUEST_CREDENTIALS');

async function registerFailure(stay) {
  if (!stay) return;
  const failures = (stay.access_failures || 0) + 1;
  const lock = failures >= MAX_FAILURES;
  await db('stays')
    .where({ id: stay.id })
    .update({ access_failures: lock ? 0 : failures, access_locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : stay.access_locked_until });
  if (lock) await audit({ actor: { type: 'system' }, action: 'guest.access_locked', entityType: 'stay', entityId: stay.id, roomId: stay.room_id });
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
  const row = await db('guest_sessions').where({ stay_id: stay.id }).whereNull('revoked_at').where('expires_at', '>', new Date()).count({ n: '*' }).first();
  if (Number(row.n) >= limit) {
    throw new AppError(409, `${limit} phone${limit === 1 ? ' is' : 's are'} already signed in for this room. Sign out on another phone or ask the front desk to reset access.`, 'DEVICE_LIMIT');
  }
}

export async function startSession(stay, guestId, method, meta) {
  if (stay) {
    // If the registered guest is signing in with email/password, rotate previous sessions for this guest
    if (method === 'password' && guestId) {
      await db('guest_sessions')
        .where({ guest_id: guestId })
        .whereNull('revoked_at')
        .update({ revoked_at: new Date() });
    }
    await assertPhoneLimit(stay);
  }
  const expiresAt = new Date(Date.now() + env.auth.guestTokenDays * 86_400_000);
  const [sid] = await db('guest_sessions').insert({
    stay_id: stay?.id || null,
    guest_id: guestId,
    method,
    user_agent: meta.userAgent?.slice(0, 255) ?? null,
    ip: meta.ip ?? null,
    expires_at: expiresAt,
  });
  if (stay) {
    await db('stays').where({ id: stay.id }).update({ access_failures: 0 });
    await audit({ actor: { type: 'guest', id: guestId }, action: 'guest.sign_in', entityType: 'stay', entityId: stay.id, roomId: stay.room_id, details: { method }, ip: meta.ip });
  } else {
    await audit({ actor: { type: 'guest', id: guestId }, action: 'guest.sign_in', entityType: 'guest', entityId: guestId, details: { method }, ip: meta.ip });
  }
  const token = jwt.sign({ sub: guestId, sid, stay: stay?.id || null }, env.auth.guestSecret, { audience: 'guest', expiresIn: `${env.auth.guestTokenDays}d` });
  return { token, expiresAt };
}

/** Booking code or QR token: both are looked up by their keyed hash among live codes. */
async function signInWithAccess(kind, value, meta) {
  const row = await db('guest_access_codes as c')
    .join('stays as s', 's.id', 'c.stay_id')
    .where({ 'c.kind': kind, 'c.lookup_hash': lookupHash(kind === 'code' ? normaliseCode(value) : value) })
    .whereNull('c.revoked_at')
    .first('s.*');
  if (!row) throw invalid();
  if (row.status === 'reserved') {
    throw new AppError(403, 'Your reservation is confirmed, but check-in has not started yet. Please check in at the front desk when you arrive.', 'NOT_CHECKED_IN');
  }
  if (row.status !== 'checked_in') throw invalid();
  assertNotLocked(row);
  return startSession(row, row.guest_id, kind === 'code' ? 'booking_code' : 'qr', meta);
}

export async function signInWithEmailAndPassword({ email, password }, meta) {
  const guest = await db('guests')
    .whereRaw('LOWER(email) = ?', [email.trim().toLowerCase()])
    .first();
  if (!guest) throw invalid();
  if (!guest.password_hash) {
    throw unauthorized('Please set a password or use your booking details to sign in', 'PASSWORD_NOT_SET');
  }
  const match = await bcrypt.compare(password, guest.password_hash);
  if (!match) throw invalid();

  const stay = (await db('stays')
    .where({ guest_id: guest.id })
    .whereIn('status', ['checked_in', 'reserved'])
    .orderBy('check_in_at', 'desc')
    .first()) || (await db('stays').where({ guest_id: guest.id }).orderBy('check_out_at', 'desc').first());

  if (stay && ['checked_in', 'reserved'].includes(stay.status)) {
    assertNotLocked(stay);
    return startSession(stay, guest.id, 'password', meta);
  }
  return startSession(stay || null, guest.id, 'password', meta);
}

async function signInWithEmail({ email, lastName }, meta) {
  const guest = await db('guests')
    .whereRaw('LOWER(email) = ?', [email.trim().toLowerCase()])
    .first();
  if (!guest) throw invalid();
  if (lastName && normaliseName(guest.last_name) !== normaliseName(lastName)) throw invalid();

  const stay = (await db('stays')
    .where({ guest_id: guest.id })
    .whereIn('status', ['checked_in', 'reserved'])
    .orderBy('check_in_at', 'desc')
    .first()) || (await db('stays').where({ guest_id: guest.id }).orderBy('check_out_at', 'desc').first());

  if (!stay) throw invalid();
  assertNotLocked(stay);
  return startSession(stay, guest.id, 'email', meta);
}

async function signInWithReference({ reference, lastName }, meta) {
  const stay = await db('stays').whereRaw('UPPER(reference) = ?', [reference.trim().toUpperCase()]).first();
  if (!stay) throw invalid();
  if (stay.status === 'reserved') {
    throw new AppError(403, 'Your reservation is confirmed, but check-in has not started yet. Please check in at the front desk when you arrive.', 'NOT_CHECKED_IN');
  }
  if (stay.status !== 'checked_in') throw invalid();
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

  let session = await db('guest_sessions')
    .where({ id: payload.sid })
    .first();

  // If this is a registered guest account (method === 'password'), keep session resilient across room check-outs
  if (session && session.method === 'password' && payload.sub) {
    const activeStay = await db('stays as s')
      .leftJoin('rooms as r', 'r.id', 's.room_id')
      .where(function() {
        this.where('s.guest_id', payload.sub).orWhereExists(function() {
          this.select('*').from('stay_guests as sg').whereRaw('sg.stay_id = s.id').andWhere('sg.guest_id', payload.sub);
        });
      })
      .whereIn('s.status', ['checked_in', 'reserved'])
      .orderBy('s.check_in_at', 'desc')
      .first('s.id as stay_id', 's.status', 's.room_id', 'r.number as room_number');

    if (activeStay) {
      if (session.revoked_at || session.stay_id !== activeStay.stay_id) {
        await db('guest_sessions').where({ id: session.id }).update({ revoked_at: null, stay_id: activeStay.stay_id });
        session.revoked_at = null;
        session.stay_id = activeStay.stay_id;
      }
    } else if (session.revoked_at) {
      // Re-enable password account session so guest can view profile and history
      await db('guest_sessions').where({ id: session.id }).update({ revoked_at: null, stay_id: null });
      session.revoked_at = null;
      session.stay_id = null;
    }
  }

  if (!session || session.revoked_at) {
    throw unauthorized('Your stay has ended or this device was signed out', 'GUEST_SESSION_ENDED');
  }

  // Resolve stay details
  let stayId = session.stay_id;
  let stay = stayId ? await db('stays').where({ id: stayId }).first() : null;

  // If the currently assigned stay has ended (checked out), look for another active stay
  if (!stay || !['checked_in', 'reserved'].includes(stay.status)) {
    if (session.method === 'password' && session.guest_id) {
      const activeStay = await db('stays as s')
        .leftJoin('rooms as r', 'r.id', 's.room_id')
        .where(function() {
          this.where('s.guest_id', session.guest_id).orWhereExists(function() {
            this.select('*').from('stay_guests as sg').whereRaw('sg.stay_id = s.id').andWhere('sg.guest_id', session.guest_id);
          });
        })
        .whereIn('s.status', ['checked_in', 'reserved'])
        .orderBy('s.check_in_at', 'desc')
        .first('s.id as stay_id', 's.status', 's.room_id', 'r.number as room_number');

      if (activeStay) {
        stayId = activeStay.stay_id;
        stay = activeStay;
        await db('guest_sessions').where({ id: session.id }).update({ stay_id: stayId });
      } else {
        // No active stay currently: guest is between stays or checked out
        stayId = null;
        stay = null;
        await db('guest_sessions').where({ id: session.id }).update({ stay_id: null });
      }
    } else {
      // Anonymous single-stay session: end session
      throw unauthorized('Your stay has ended or this device was signed out', 'GUEST_SESSION_ENDED');
    }
  }

  const room = stay?.room_id ? await db('rooms').where({ id: stay.room_id }).first('id', 'number') : null;

  return {
    guestId: session.guest_id,
    stayId: stayId || null,
    roomId: room?.id || null,
    roomNumber: room?.number || null,
    sessionId: session.id,
  };
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
