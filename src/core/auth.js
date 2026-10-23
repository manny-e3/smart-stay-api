import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { db } from '../config/db.js';
import { unauthorized, forbidden } from './errors.js';
import { can } from './permissions.js';

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function signAccessToken(staff, sessionId) {
  return jwt.sign({ sub: staff.id, role: staff.role, sid: sessionId }, env.auth.accessSecret, {
    expiresIn: `${env.auth.accessMinutes}m`,
    audience: 'staff',
  });
}

/**
 * Verifies an access token and confirms the session is live and the staff member is active.
 * The database check means deactivating a staff member or logging out takes effect at once.
 */
export async function resolveAccessToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.auth.accessSecret, { audience: 'staff' });
  } catch (err) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token', err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED');
  }
  const row = await db('sessions as s')
    .join('staff as st', 'st.id', 's.staff_id')
    .where({ 's.id': payload.sid, 's.staff_id': payload.sub, 'st.is_active': true })
    .whereNull('s.revoked_at')
    .where('s.expires_at', '>', db.fn.now(3))
    .first('st.id', 'st.name', 'st.email', 'st.role', 's.id as session_id');
  if (!row) throw unauthorized('Session is no longer valid', 'SESSION_INVALID');
  return { id: row.id, name: row.name, email: row.email, role: row.role, sessionId: row.session_id };
}

export async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();
  req.staff = await resolveAccessToken(token);
  next();
}

/** Route guard: the authenticated staff member's role must have the permission. */
export const authorize = (permission) => (req, res, next) => {
  if (!req.staff) throw unauthorized();
  if (!can(req.staff.role, permission)) throw forbidden();
  next();
};
