import { env } from '../config/env.js';
import * as authService from '../services/auth.service.js';

/** Staff sign-in and "my account" endpoints, mounted at /staff. */

const REFRESH_COOKIE = 'ss_refresh';
const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'lax',
  path: '/staff',
  maxAge: env.auth.refreshDays * 86_400_000,
});

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

function sendTokens(res, result) {
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions());
  res.json({
    success: true,
    data: {
      accessToken: result.accessToken,
      expiresIn: result.accessTokenExpiresIn,
      refreshToken: result.refreshToken,
      staff: result.staff,
    },
  });
}

/** POST /staff/login */
export async function login(req, res) {
  sendTokens(res, await authService.login(req.valid.body, meta(req)));
}

/** POST /staff/refresh */
export async function refresh(req, res) {
  const token = req.valid.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
  sendTokens(res, await authService.refresh(token, meta(req)));
}

/** POST /staff/logout. An expired access token doesn't stop a logout; the refresh token is enough. */
export async function logout(req, res) {
  const token = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
  let staff = null;
  const [scheme, accessToken] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Bearer' && accessToken) {
    try {
      staff = await authService.resolveAccessToken(accessToken);
    } catch {
      // Ignore: sign out with the refresh token instead.
    }
  }
  await authService.logout({ sessionId: staff?.sessionId, refreshToken: token, staffId: staff?.id, ip: req.ip });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ success: true });
}

/** GET /staff/me */
export async function me(req, res) {
  res.json({ success: true, data: await authService.getMe(req.staff.id) });
}

/** POST /staff/me/password */
export async function changePassword(req, res) {
  await authService.changePassword(req.staff.id, req.valid.body, { ip: req.ip, sessionId: req.staff.sessionId });
  res.json({ success: true });
}

/** POST /staff/me/otp/setup */
export async function setupOtp(req, res) {
  res.json({ success: true, data: await authService.setupOtp(req.staff.id) });
}

/** POST /staff/me/otp/enable */
export async function enableOtp(req, res) {
  await authService.enableOtp(req.staff.id, req.valid.body.code, req.ip);
  res.json({ success: true });
}

/** POST /staff/me/otp/disable */
export async function disableOtp(req, res) {
  await authService.disableOtp(req.staff.id, req.valid.body.code, req.ip);
  res.json({ success: true });
}

/** GET /staff/push/public-key */
export function pushPublicKey(req, res) {
  res.json({ success: true, data: { publicKey: env.vapid.publicKey || null } });
}

/** POST /staff/me/push-subscriptions */
export async function savePushSubscription(req, res) {
  await authService.savePushSubscription(req.staff.id, req.valid.body);
  res.status(201).json({ success: true });
}

/** DELETE /staff/me/push-subscriptions */
export async function deletePushSubscription(req, res) {
  await authService.deletePushSubscription(req.staff.id, req.valid.body.endpoint);
  res.json({ success: true });
}
