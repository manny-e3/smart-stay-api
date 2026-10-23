import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { validate } from '../../core/validate.js';
import { authenticate } from '../../core/auth.js';
import * as auth from './auth.service.js';

const router = Router();

const REFRESH_COOKIE = 'ss_refresh';
const cookieOptions = () => ({
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'lax',
  path: '/staff',
  maxAge: env.auth.refreshDays * 86_400_000,
});

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

const sendTokens = (res, result) => {
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
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isTest ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many login attempts, try again later' },
});

const loginBody = z.object({
  email: z.email().max(190),
  password: z.string().min(1).max(200),
  otp: z.string().regex(/^\d{6}$/).optional(),
});

router.post('/login', loginLimiter, validate({ body: loginBody }), async (req, res) => {
  sendTokens(res, await auth.login(req.valid.body, meta(req)));
});

const refreshBody = z.object({ refreshToken: z.string().min(10).optional() }).optional();

router.post('/refresh', loginLimiter, validate({ body: refreshBody }), async (req, res) => {
  const token = req.valid.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
  sendTokens(res, await auth.refresh(token, meta(req)));
});

router.post('/logout', async (req, res) => {
  const token = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
  let staff = null;
  if (req.get('authorization')) {
    try {
      await authenticate(req, res, () => {});
      staff = req.staff;
    } catch {
      // An expired access token should not stop a logout; the refresh token is enough.
    }
  }
  await auth.logout({ sessionId: staff?.sessionId, refreshToken: token, staffId: staff?.id, ip: req.ip });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ success: true });
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ success: true, data: await auth.getMe(req.staff.id) });
});

router.post(
  '/me/password',
  authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(200) }) }),
  async (req, res) => {
    await auth.changePassword(req.staff.id, req.valid.body, { ip: req.ip, sessionId: req.staff.sessionId });
    res.json({ success: true });
  },
);

const otpBody = z.object({ code: z.string().regex(/^\d{6}$/) });

router.post('/me/otp/setup', authenticate, async (req, res) => {
  res.json({ success: true, data: await auth.setupOtp(req.staff.id) });
});

router.post('/me/otp/enable', authenticate, validate({ body: otpBody }), async (req, res) => {
  await auth.enableOtp(req.staff.id, req.valid.body.code, req.ip);
  res.json({ success: true });
});

router.post('/me/otp/disable', authenticate, validate({ body: otpBody }), async (req, res) => {
  await auth.disableOtp(req.staff.id, req.valid.body.code, req.ip);
  res.json({ success: true });
});

router.get('/push/public-key', (req, res) => {
  res.json({ success: true, data: { publicKey: env.vapid.publicKey || null } });
});

const pushBody = z.object({
  endpoint: z.url().max(500),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

router.post('/me/push-subscriptions', authenticate, validate({ body: pushBody }), async (req, res) => {
  await auth.savePushSubscription(req.staff.id, req.valid.body);
  res.status(201).json({ success: true });
});

router.delete('/me/push-subscriptions', authenticate, validate({ body: z.object({ endpoint: z.string().min(1) }) }), async (req, res) => {
  await auth.deletePushSubscription(req.staff.id, req.valid.body.endpoint);
  res.json({ success: true });
});

export default router;
