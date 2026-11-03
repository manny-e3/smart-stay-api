import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { getSettings } from '../services/settings.service.js';

/**
 * Limits how often a caller can hit a route.
 *   limiter({ limit: 10, minutes: 15 })                 per IP address
 *   limiter({ limit: 30, minutes: 5, byGuest: true })   per signed-in guest app session
 * Limits are relaxed in tests.
 */
export function limiter({ limit, minutes = 1, byGuest = false, keyPrefix = 'guest-session', message = 'Too many attempts, please wait a moment' }) {
  return rateLimit({
    windowMs: minutes * 60_000,
    limit: env.isTest ? 1000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(byGuest ? { keyGenerator: (req) => `${keyPrefix}:${req.guest.sessionId}` } : {}),
    message: { success: false, code: 'RATE_LIMITED', message },
  });
}

/** Device commands per guest app session per minute, from the guest_commands_per_minute setting. */
export const guestCommandLimiter = rateLimit({
  windowMs: 60_000,
  limit: async () => (env.isTest ? 1000 : (await getSettings()).guest_commands_per_minute),
  keyGenerator: (req) => `guest-commands:${req.guest.sessionId}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many changes in a short time, please wait a moment' },
});
