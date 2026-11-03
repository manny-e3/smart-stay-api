import { z } from 'zod';
import { boolish } from './common.validator.js';
import { REQUEST_CATEGORIES } from '../services/requests.service.js';

/* ---- Sign-in and account (public) ---- */

/** POST /guest/login: one of five ways to sign in. */
export const loginBody = z.union([
  z.object({ email: z.string().trim().email(), password: z.string().min(1) }).strict(),
  z.object({ bookingCode: z.string().trim().min(6).max(20) }).strict(),
  z.object({ qrToken: z.string().trim().min(16).max(200) }).strict(),
  z.object({ reference: z.string().trim().min(4).max(20), lastName: z.string().trim().min(1).max(80) }).strict(),
  z.object({ email: z.string().trim().email(), lastName: z.string().trim().min(1).max(80).optional() }).strict(),
]);

export const registerBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).optional(),
  password: z.string().min(6).max(100),
});

export const forgotPasswordBody = z.object({ email: z.string().trim().email() });

export const resetPasswordBody = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().min(4).max(10),
  newPassword: z.string().min(6).max(100),
});

/* ---- Booking (public) ---- */

/** POST /guest/bookings */
export const bookingBody = z.object({
  roomType: z.string().trim().min(1).max(80),
  arrival: z.string().trim().min(10),
  departure: z.string().trim().min(10),
  adults: z.number().int().min(1).max(10).default(1),
  children: z.number().int().min(0).max(10).default(0),
  guest: z.object({
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    email: z.string().trim().email(),
    phone: z.string().trim().max(30).optional(),
    notes: z.string().trim().max(500).optional(),
  }),
  specialRequests: z.string().trim().max(500).optional(),
  paymentMethod: z.enum(['credit_card', 'pay_at_hotel', 'member_account']).default('credit_card'),
  cardLast4: z.string().trim().max(4).optional(),
  instantAccess: z.boolean().optional().default(true),
});

/* ---- Signed in ---- */

/** POST /guest/link-booking: any one of these identifies the booking. */
export const linkBookingBody = z.object({
  bookingCode: z.string().trim().optional(),
  reference: z.string().trim().optional(),
  lastName: z.string().trim().optional(),
  qrToken: z.string().trim().optional(),
  qrData: z.string().trim().optional(),
});

export const pushTokenBody = z.object({ pushToken: z.string().min(10).max(255), platform: z.enum(['ios', 'android', 'web']) });

export const unlockBody = z.object({ deviceId: z.number().int().positive().optional() }).optional();

/** POST /guest/devices/:id/command: checked against the device's capabilities in the service. */
export const deviceCommandBody = z.record(z.string(), z.any());

export const roomStatusBody = z
  .object({ dnd: z.boolean().optional(), cleaningRequested: z.boolean().optional(), note: z.string().trim().max(300).optional() })
  .strict()
  .refine((b) => b.dnd !== undefined || b.cleaningRequested !== undefined, { message: 'Send dnd or cleaningRequested' });

export const requestBody = z.object({
  category: z.enum(REQUEST_CATEGORIES),
  description: z.string().trim().max(1000).optional(),
  preferredAt: z.coerce.date().optional(),
});

/** POST /guest/feedback: JSON, or multipart/form-data with photos (fields arrive as text). */
export const feedbackBody = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  category: z.string().trim().max(40).optional(),
  comment: z.string().trim().max(2000).optional(),
  markAsIssue: z.union([z.boolean(), boolish]).optional(),
});

/** Saved room preferences: lights, temperature and music. */
export const preferencesSchema = z
  .object({
    lights: z.object({ on: z.boolean().optional(), brightness: z.number().int().min(0).max(100).optional() }).strict().optional(),
    temperature: z
      .object({
        setpoint: z.number().min(10).max(35),
        mode: z.enum(['cool', 'heat', 'auto', 'fan']).optional(),
        fan: z.enum(['auto', 'low', 'medium', 'high']).optional(),
      })
      .strict()
      .optional(),
    music: z.object({ source: z.string().trim().max(40).optional(), volume: z.number().int().min(0).max(100).optional(), autoplay: z.boolean().optional() }).strict().optional(),
  })
  .strict();

export const preferencesBody = z.object({ preferences: preferencesSchema, applyNow: z.boolean().optional() });

export const voiceCommandBody = z.object({ speechText: z.string().trim().min(1).max(500) });
