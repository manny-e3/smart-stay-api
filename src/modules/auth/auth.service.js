import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { db } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { AppError, unauthorized, badRequest } from '../../core/errors.js';
import { sha256, signAccessToken } from '../../core/auth.js';
import { generateSecret, verifyCode, otpauthUrl } from '../../core/totp.js';

export const PASSWORD_RULES = 'at least 10 characters with a letter and a number';
export const isStrongPassword = (p) => typeof p === 'string' && p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p);
export const hashPassword = (p) => bcrypt.hash(p, 12);

// Used to keep login timing the same whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-0', 12);

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

async function createSession(staff, meta, trx = db) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + env.auth.refreshDays * 86_400_000);
  const [sessionId] = await trx('sessions').insert({
    staff_id: staff.id,
    refresh_token_hash: sha256(refreshToken),
    user_agent: meta.userAgent?.slice(0, 255) ?? null,
    ip: meta.ip ?? null,
    expires_at: expiresAt,
  });
  return {
    accessToken: signAccessToken(staff, sessionId),
    accessTokenExpiresIn: env.auth.accessMinutes * 60,
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
  };
}

/** Email + password login, with the one-time code when the account has it switched on. */
export async function login({ email, password, otp }, meta) {
  const staff = await db('staff').whereRaw('LOWER(email) = ?', [email.toLowerCase()]).first();
  const passwordOk = await bcrypt.compare(password, staff?.password_hash ?? DUMMY_HASH);

  if (!staff || !staff.is_active) {
    if (staff) await audit({ actor: { type: 'staff', id: staff.id }, action: 'auth.login_failed', entityType: 'staff', entityId: staff.id, details: { reason: 'inactive' }, ip: meta.ip });
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

  return db.transaction(async (trx) => {
    await trx('staff').where({ id: staff.id }).update({ failed_attempts: 0, locked_until: null, last_login_at: new Date() });
    const tokens = await createSession(staff, meta, trx);
    await audit({ actor: { type: 'staff', id: staff.id }, action: 'auth.login', entityType: 'staff', entityId: staff.id, ip: meta.ip }, trx);
    return { ...tokens, staff: publicStaff(staff) };
  });
}

async function registerFailure(staff, reason, meta) {
  const attempts = staff.failed_attempts + 1;
  const lock = attempts >= env.auth.maxAttempts;
  await db('staff')
    .where({ id: staff.id })
    .update({ failed_attempts: lock ? 0 : attempts, locked_until: lock ? new Date(Date.now() + env.auth.lockMinutes * 60_000) : null });
  await audit({
    actor: { type: 'staff', id: staff.id },
    action: lock ? 'auth.locked' : 'auth.login_failed',
    entityType: 'staff',
    entityId: staff.id,
    details: { reason, attempts },
    ip: meta.ip,
  });
}

/** Rotates the refresh token: the old one stops working and a new pair is issued. */
export async function refresh(refreshToken, meta) {
  if (!refreshToken) throw unauthorized('Refresh token missing', 'REFRESH_INVALID');
  const session = await db('sessions as s')
    .join('staff as st', 'st.id', 's.staff_id')
    .where('s.refresh_token_hash', sha256(refreshToken))
    .first('s.id as session_id', 's.revoked_at', 's.expires_at', 'st.*');
  if (!session) throw unauthorized('Invalid refresh token', 'REFRESH_INVALID');

  if (session.revoked_at) {
    // A revoked token being reused suggests theft: end every session for this account.
    await db('sessions').where({ staff_id: session.id }).whereNull('revoked_at').update({ revoked_at: new Date() });
    await audit({ actor: { type: 'staff', id: session.id }, action: 'auth.refresh_reuse', entityType: 'staff', entityId: session.id, ip: meta.ip });
    throw unauthorized('Invalid refresh token', 'REFRESH_INVALID');
  }
  if (new Date(session.expires_at) <= new Date() || !session.is_active) throw unauthorized('Session expired', 'REFRESH_INVALID');

  return db.transaction(async (trx) => {
    await trx('sessions').where({ id: session.session_id }).update({ revoked_at: new Date() });
    const tokens = await createSession(session, meta, trx);
    return { ...tokens, staff: publicStaff(session) };
  });
}

export async function logout({ sessionId, refreshToken, staffId, ip }) {
  const q = db('sessions').whereNull('revoked_at');
  if (sessionId) q.where({ id: sessionId });
  else if (refreshToken) q.where({ refresh_token_hash: sha256(refreshToken) });
  else return;
  await q.update({ revoked_at: new Date() });
  if (staffId) await audit({ actor: { type: 'staff', id: staffId }, action: 'auth.logout', entityType: 'staff', entityId: staffId, ip });
}

export async function revokeAllSessions(staffId, trx = db) {
  await trx('sessions').where({ staff_id: staffId }).whereNull('revoked_at').update({ revoked_at: new Date() });
}

export async function getMe(staffId) {
  return publicStaff(await db('staff').where({ id: staffId }).first());
}

export async function changePassword(staffId, { currentPassword, newPassword }, meta) {
  const staff = await db('staff').where({ id: staffId }).first();
  if (!(await bcrypt.compare(currentPassword, staff.password_hash))) throw badRequest('Current password is incorrect');
  if (!isStrongPassword(newPassword)) throw badRequest(`New password must be ${PASSWORD_RULES}`);
  await db.transaction(async (trx) => {
    await trx('staff').where({ id: staffId }).update({ password_hash: await hashPassword(newPassword) });
    // Keep the current session, end all others.
    await trx('sessions').where({ staff_id: staffId }).whereNot({ id: meta.sessionId }).whereNull('revoked_at').update({ revoked_at: new Date() });
    await audit({ actor: { type: 'staff', id: staffId }, action: 'auth.password_changed', entityType: 'staff', entityId: staffId, ip: meta.ip }, trx);
  });
}

/** Step 1 of turning on the one-time code: create a secret for the authenticator app. */
export async function setupOtp(staffId) {
  const staff = await db('staff').where({ id: staffId }).first();
  if (staff.otp_enabled) throw badRequest('One-time code is already enabled');
  const secret = generateSecret();
  await db('staff').where({ id: staffId }).update({ otp_secret: secret });
  return { secret, otpauthUrl: otpauthUrl(secret, staff.email) };
}

/** Step 2: confirm with a code from the app, which switches the check on at login. */
export async function enableOtp(staffId, code, ip) {
  const staff = await db('staff').where({ id: staffId }).first();
  if (!staff.otp_secret) throw badRequest('Run one-time code setup first');
  if (!verifyCode(staff.otp_secret, code)) throw badRequest('Invalid one-time code');
  await db('staff').where({ id: staffId }).update({ otp_enabled: true });
  await audit({ actor: { type: 'staff', id: staffId }, action: 'auth.otp_enabled', entityType: 'staff', entityId: staffId, ip });
}

export async function disableOtp(staffId, code, ip) {
  const staff = await db('staff').where({ id: staffId }).first();
  if (!staff.otp_enabled) throw badRequest('One-time code is not enabled');
  if (!verifyCode(staff.otp_secret, code)) throw badRequest('Invalid one-time code');
  await db('staff').where({ id: staffId }).update({ otp_enabled: false, otp_secret: null });
  await audit({ actor: { type: 'staff', id: staffId }, action: 'auth.otp_disabled', entityType: 'staff', entityId: staffId, ip });
}

export async function savePushSubscription(staffId, { endpoint, keys }) {
  await db('push_subscriptions')
    .insert({ staff_id: staffId, endpoint, endpoint_hash: sha256(endpoint), keys: JSON.stringify(keys) })
    .onConflict('endpoint_hash')
    .merge(['staff_id', 'keys']);
}

export async function deletePushSubscription(staffId, endpoint) {
  await db('push_subscriptions').where({ staff_id: staffId, endpoint_hash: sha256(endpoint) }).del();
}
