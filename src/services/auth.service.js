import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { transaction } from '../config/db.js';
import * as Staff from '../models/staff.model.js';
import { recordAudit } from './audit.service.js';
import { AppError, unauthorized, badRequest } from '../utils/errors.js';
import { sha256 } from '../utils/crypto.js';
import { generateSecret, verifyCode, otpauthUrl } from '../utils/totp.js';

/** Staff sign-in, sessions, passwords, one-time codes and browser push subscriptions. */

export const PASSWORD_RULES = 'at least 10 characters with a letter and a number';
export const isStrongPassword = (p) => typeof p === 'string' && p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p);
export const hashPassword = (p) => bcrypt.hash(p, 12);

// Used to keep login timing the same whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-0', 12);

/** The staff fields that are safe to send to the dashboard. */
export const publicStaff = (s) => ({
  id: s.id,
  name: s.name,
  email: s.email,
  role: s.role,
  isActive: Boolean(s.is_active),
  otpEnabled: Boolean(s.otp_enabled),
  lastLoginAt: s.last_login_at ?? null,
  createdAt: s.created_at,
});

/* ---- Access tokens ------------------------------------------------------------ */

export function signAccessToken(staff, sessionId) {
  return jwt.sign({ sub: staff.id, role: staff.role, sid: sessionId }, env.auth.accessSecret, {
    expiresIn: `${env.auth.accessMinutes}m`,
    audience: 'staff',
  });
}

/**
 * Checks an access token and that its session is still live and the staff member active.
 * Checking the database means logging out or deactivating someone takes effect at once.
 */
export async function resolveAccessToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.auth.accessSecret, { audience: 'staff' });
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    throw unauthorized(expired ? 'Access token expired' : 'Invalid access token', expired ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED');
  }
  const row = await Staff.findLiveSession(payload.sid, payload.sub);
  if (!row) throw unauthorized('Session is no longer valid', 'SESSION_INVALID');
  return { id: row.id, name: row.name, email: row.email, role: row.role, sessionId: row.session_id };
}

async function createSession(staff, meta, trx) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + env.auth.refreshDays * 86_400_000);
  const sessionId = await Staff.createSession(
    {
      staff_id: staff.id,
      refresh_token_hash: sha256(refreshToken),
      user_agent: meta.userAgent?.slice(0, 255) ?? null,
      ip: meta.ip ?? null,
      expires_at: expiresAt,
    },
    trx,
  );
  return {
    accessToken: signAccessToken(staff, sessionId),
    accessTokenExpiresIn: env.auth.accessMinutes * 60,
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
  };
}

/* ---- Login, refresh, logout --------------------------------------------------- */

/** Email + password login, plus the one-time code when the account has it switched on. */
export async function login({ email, password, otp }, meta) {
  const staff = await Staff.findByEmail(email);
  const passwordOk = await bcrypt.compare(password, staff?.password_hash ?? DUMMY_HASH);

  if (!staff || !staff.is_active) {
    if (staff) await recordAudit({ actor: { type: 'staff', id: staff.id }, action: 'auth.login_failed', entityType: 'staff', entityId: staff.id, details: { reason: 'inactive' }, ip: meta.ip });
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
    throw new AppError(423, 'Account temporarily locked after too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');
  }

  if (!passwordOk) {
    await registerFailure(staff, 'password', meta);
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (staff.otp_enabled) {
    if (!otp) throw unauthorized('One-time code required', 'OTP_REQUIRED');
    if (!verifyCode(staff.otp_secret, otp)) {
      await registerFailure(staff, 'otp', meta);
      throw unauthorized('Invalid one-time code', 'INVALID_OTP');
    }
  }

  return transaction(async (trx) => {
    await Staff.update(staff.id, { failed_attempts: 0, locked_until: null, last_login_at: new Date() }, trx);
    const tokens = await createSession(staff, meta, trx);
    await recordAudit({ actor: { type: 'staff', id: staff.id }, action: 'auth.login', entityType: 'staff', entityId: staff.id, ip: meta.ip }, trx);
    return { ...tokens, staff: publicStaff(staff) };
  });
}

async function registerFailure(staff, reason, meta) {
  const attempts = staff.failed_attempts + 1;
  const lock = attempts >= env.auth.maxAttempts;
  await Staff.update(staff.id, { failed_attempts: lock ? 0 : attempts, locked_until: lock ? new Date(Date.now() + env.auth.lockMinutes * 60_000) : null });
  await recordAudit({
    actor: { type: 'staff', id: staff.id },
    action: lock ? 'auth.locked' : 'auth.login_failed',
    entityType: 'staff',
    entityId: staff.id,
    details: { reason, attempts },
    ip: meta.ip,
  });
}

/** Swaps a refresh token for a new pair. The old one stops working. */
export async function refresh(refreshToken, meta) {
  if (!refreshToken) throw unauthorized('Refresh token missing', 'REFRESH_INVALID');
  const session = await Staff.findSessionByRefreshHash(sha256(refreshToken));
  if (!session) throw unauthorized('Invalid refresh token', 'REFRESH_INVALID');

  if (session.revoked_at) {
    // Reusing a revoked token suggests it was stolen: end every session for this account.
    await Staff.revokeAllSessions(session.id);
    await recordAudit({ actor: { type: 'staff', id: session.id }, action: 'auth.refresh_reuse', entityType: 'staff', entityId: session.id, ip: meta.ip });
    throw unauthorized('Invalid refresh token', 'REFRESH_INVALID');
  }
  if (new Date(session.expires_at) <= new Date() || !session.is_active) throw unauthorized('Session expired', 'REFRESH_INVALID');

  return transaction(async (trx) => {
    await Staff.revokeSession(session.session_id, trx);
    const tokens = await createSession(session, meta, trx);
    return { ...tokens, staff: publicStaff(session) };
  });
}

export async function logout({ sessionId, refreshToken, staffId, ip }) {
  if (!sessionId && !refreshToken) return;
  await Staff.revokeOpenSession({ sessionId, refreshTokenHash: refreshToken ? sha256(refreshToken) : undefined });
  if (staffId) await recordAudit({ actor: { type: 'staff', id: staffId }, action: 'auth.logout', entityType: 'staff', entityId: staffId, ip });
}

export const revokeAllSessions = (staffId, trx) => Staff.revokeAllSessions(staffId, trx);

/* ---- My account ---------------------------------------------------------------- */

export async function getMe(staffId) {
  return publicStaff(await Staff.findById(staffId));
}

export async function changePassword(staffId, { currentPassword, newPassword }, meta) {
  const staff = await Staff.findById(staffId);
  if (!(await bcrypt.compare(currentPassword, staff.password_hash))) throw badRequest('Current password is incorrect');
  if (!isStrongPassword(newPassword)) throw badRequest(`New password must be ${PASSWORD_RULES}`);
  const passwordHash = await hashPassword(newPassword);
  await transaction(async (trx) => {
    await Staff.update(staffId, { password_hash: passwordHash }, trx);
    // Keep the current session, end all others.
    await Staff.revokeOtherSessions(staffId, meta.sessionId, trx);
    await recordAudit({ actor: { type: 'staff', id: staffId }, action: 'auth.password_changed', entityType: 'staff', entityId: staffId, ip: meta.ip }, trx);
  });
}

/** Step 1 of turning on the one-time code: create a secret for the authenticator app. */
export async function setupOtp(staffId) {
  const staff = await Staff.findById(staffId);
  if (staff.otp_enabled) throw badRequest('One-time code is already enabled');
  const secret = generateSecret();
  await Staff.update(staffId, { otp_secret: secret });
  return { secret, otpauthUrl: otpauthUrl(secret, staff.email) };
}

/** Step 2: confirm with a code from the app, which switches the check on at login. */
export async function enableOtp(staffId, code, ip) {
  const staff = await Staff.findById(staffId);
  if (!staff.otp_secret) throw badRequest('Run one-time code setup first');
  if (!verifyCode(staff.otp_secret, code)) throw badRequest('Invalid one-time code');
  await Staff.update(staffId, { otp_enabled: true });
  await recordAudit({ actor: { type: 'staff', id: staffId }, action: 'auth.otp_enabled', entityType: 'staff', entityId: staffId, ip });
}

export async function disableOtp(staffId, code, ip) {
  const staff = await Staff.findById(staffId);
  if (!staff.otp_enabled) throw badRequest('One-time code is not enabled');
  if (!verifyCode(staff.otp_secret, code)) throw badRequest('Invalid one-time code');
  await Staff.update(staffId, { otp_enabled: false, otp_secret: null });
  await recordAudit({ actor: { type: 'staff', id: staffId }, action: 'auth.otp_disabled', entityType: 'staff', entityId: staffId, ip });
}

/* ---- Browser push ------------------------------------------------------------- */

export function savePushSubscription(staffId, { endpoint, keys }) {
  return Staff.savePushSubscription({ staffId, endpoint, endpointHash: sha256(endpoint), keys });
}

export function deletePushSubscription(staffId, endpoint) {
  return Staff.deletePushSubscription(staffId, sha256(endpoint));
}
