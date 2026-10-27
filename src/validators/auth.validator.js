import { z } from 'zod';

const sixDigits = z.string().regex(/^\d{6}$/);

/** POST /staff/login */
export const loginBody = z.object({
  email: z.email().max(190),
  password: z.string().min(1).max(200),
  otp: sixDigits.optional(),
});

/** POST /staff/refresh (the refresh token can also come from the cookie) */
export const refreshBody = z.object({ refreshToken: z.string().min(10).optional() }).optional();

/** POST /staff/me/password */
export const changePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(200) });

/** POST /staff/me/otp/enable and /disable */
export const otpBody = z.object({ code: sixDigits });

/** POST /staff/me/push-subscriptions */
export const pushSubscriptionBody = z.object({
  endpoint: z.url().max(500),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

/** DELETE /staff/me/push-subscriptions */
export const deletePushSubscriptionBody = z.object({ endpoint: z.string().min(1) });
