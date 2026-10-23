import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { db } from '../../config/db.js';
import { badRequest, AppError } from '../../core/errors.js';
import { lookupHash, normaliseCode } from '../../core/crypto.js';
import { validate, idParam, boolish } from '../../core/validate.js';
import { authenticateGuest, signIn, signOut } from './guest.auth.js';
import { getRoomStatus, setRoomStatus } from './roomStatus.service.js';
import { getPreferences, savePreferences, preferencesSchema, applyGuestPreferences } from './preferences.service.js';
import { guestKeys, keySummary, remoteUnlock } from '../keys/keys.service.js';
import { guestCommand, listRoomDevices, roomEcoState } from '../controls/controls.service.js';
import { createGuestRequest, listGuestRequests, getGuestRequest, cancelByGuest, REQUEST_CATEGORIES } from '../requests/requests.service.js';
import { submitFeedback } from '../feedback/feedback.service.js';
import { getSettings } from '../settings/settings.service.js';
import { sendEmail } from '../../core/notifier.js';

/**
 * Guest app API (mobile and web). Every handler works only on the signed-in guest's own
 * stay and current room (req.guest). Ids in paths are always checked against that stay or room.
 */
const router = Router();

const limiter = ({ limit, minutes = 1, byGuest = false }) =>
  rateLimit({
    windowMs: minutes * 60_000,
    limit: env.isTest ? 1000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(byGuest ? { keyGenerator: (req) => `guest-session:${req.guest.sessionId}` } : {}),
    message: { success: false, code: 'RATE_LIMITED', message: 'Too many attempts, please wait a moment' },
  });

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/* ---- Public ------------------------------------------------------------ */

/** Help screen and welcome screen content: reception phone, FAQs, privacy notice, quick links. */
router.get('/info', async (req, res) => {
  const s = await getSettings();
  res.json({
    success: true,
    data: { hotelName: s.hotel_name, receptionPhone: s.reception_phone || null, faqs: s.guest_faqs, privacyNotice: s.privacy_notice || null, quickLinks: s.guest_quick_links },
  });
});

router.post(
  '/login',
  limiter({ limit: 10, minutes: 15 }),
  validate({
    body: z.union([
      z.object({ email: z.string().trim().email(), password: z.string().min(1) }).strict(),
      z.object({ bookingCode: z.string().trim().min(6).max(20) }).strict(),
      z.object({ qrToken: z.string().trim().min(16).max(200) }).strict(),
      z.object({ reference: z.string().trim().min(4).max(20), lastName: z.string().trim().min(1).max(80) }).strict(),
      z.object({ email: z.string().trim().email(), lastName: z.string().trim().min(1).max(80).optional() }).strict(),
    ]),
  }),
  async (req, res) => {
    res.status(201).json({ success: true, data: await signIn(req.valid.body, meta(req)) });
  },
);

router.post(
  '/register',
  limiter({ limit: 10, minutes: 15 }),
  validate({
    body: z.object({
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
      email: z.string().trim().email(),
      phone: z.string().trim().max(40).optional(),
      password: z.string().min(6).max(100),
    }),
  }),
  async (req, res) => {
    const { firstName, lastName, email, phone, password } = req.valid.body;
    const normalizedEmail = email.toLowerCase().trim();
    let guest = await db('guests').whereRaw('LOWER(email) = ?', [normalizedEmail]).first();

    if (guest && guest.password_hash) {
      throw new AppError(409, 'An account with this email already exists. Please log in or reset your password.', 'EMAIL_EXISTS');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    if (guest) {
      await db('guests').where({ id: guest.id }).update({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        phone: phone ? phone.trim() : guest.phone,
        password_hash: passwordHash,
        updated_at: new Date(),
      });
      guest = await db('guests').where({ id: guest.id }).first();
    } else {
      const [id] = await db('guests').insert({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: normalizedEmail,
        phone: phone ? phone.trim() : null,
        language: 'en',
        password_hash: passwordHash,
      });
      guest = await db('guests').where({ id }).first();
    }

    // Send Welcome Email (non-blocking for sub-50ms response)
    sendEmail({
      to: guest.email,
      subject: `Welcome to SmartStay, ${guest.first_name}!`,
      text: `Hello ${guest.first_name},\n\nWelcome to SmartStay! Your mobile guest account is ready.\n\nWith your account you can manage your bookings, room keys, and in-room controls.\n\nWarm regards,\nThe SmartStay Team`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #ffffff; color: #1e293b; border-radius: 12px; border: 1px solid #e2e8f0;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #0f172a; font-size: 24px; font-weight: 700; margin: 0 0 8px 0;">Welcome to SmartStay</h1>
            <p style="color: #64748b; font-size: 15px; margin: 0;">Smart Hospitality, Elevated Comfort</p>
          </div>
          <div style="background: #f8fafc; border-radius: 10px; padding: 20px; margin-bottom: 20px; border: 1px solid #edf2f7;">
            <p style="margin: 0 0 12px 0; font-size: 16px; color: #334155;">Hello <strong>${guest.first_name}</strong>,</p>
            <p style="margin: 0 0 12px 0; font-size: 15px; line-height: 1.6; color: #475569;">Thank you for registering your SmartStay mobile account. Your companion app is ready to elevate your stay.</p>
            <p style="margin: 0; font-size: 14px; font-weight: 600; color: #0f172a;">What you can do with your SmartStay app:</p>
            <ul style="margin: 10px 0 0 0; padding-left: 20px; font-size: 14px; line-height: 1.7; color: #475569;">
              <li>Instant digital room key access</li>
              <li>Smart room controls for lighting, climate & entertainment</li>
              <li>Housekeeping and concierge service requests</li>
              <li>Review complete past stays and room records</li>
            </ul>
          </div>
          <p style="font-size: 13px; color: #94a3b8; text-align: center; margin: 20px 0 0 0;">
            If you did not sign up for this account, please contact our front desk.
          </p>
        </div>
      `,
    }).catch((err) => console.error("[mail] Welcome email failed:", err.message));

    try {
      const session = await signIn({ email: guest.email, password }, meta(req));
      return res.status(201).json({
        success: true,
        data: {
          guest: { id: guest.id, firstName: guest.first_name, lastName: guest.last_name, email: guest.email, phone: guest.phone },
          session,
        },
      });
    } catch {
      return res.status(201).json({
        success: true,
        data: {
          guest: { id: guest.id, firstName: guest.first_name, lastName: guest.last_name, email: guest.email, phone: guest.phone },
        },
      });
    }
  },
);

router.post(
  '/forgot-password',
  limiter({ limit: 10, minutes: 15 }),
  validate({
    body: z.object({
      email: z.string().trim().email(),
    }),
  }),
  async (req, res) => {
    const { email } = req.valid.body;
    const guest = await db('guests').whereRaw('LOWER(email) = ?', [email.toLowerCase().trim()]).first();

    if (guest) {
      const code = String(crypto.randomInt(100000, 999999));
      const expiresAt = new Date(Date.now() + 15 * 60_000);

      await db('guests').where({ id: guest.id }).update({
        reset_token: code,
        reset_expires_at: expiresAt,
        updated_at: new Date(),
      });

      sendEmail({
        to: guest.email,
        subject: `SmartStay - Password Reset Code: ${code}`,
        text: `Hello ${guest.first_name},\n\nYou requested to reset your password.\n\nYour 6-digit verification code is: ${code}\n\nThis code will expire in 15 minutes.`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #ffffff; color: #1e293b; border-radius: 12px; border: 1px solid #e2e8f0;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #0f172a; font-size: 24px; font-weight: 700; margin: 0 0 8px 0;">Reset Your Password</h1>
              <p style="color: #64748b; font-size: 15px; margin: 0;">SmartStay Guest Account</p>
            </div>
            <div style="background: #f8fafc; border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 24px; border: 1px solid #edf2f7;">
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #475569;">Enter this verification code in the mobile app to set a new password:</p>
              <div style="display: inline-block; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #0284c7; background: #e0f2fe; padding: 12px 28px; border-radius: 8px; border: 1px dashed #38bdf8;">
                ${code}
              </div>
              <p style="margin: 16px 0 0 0; font-size: 13px; color: #64748b;">This code will expire in 15 minutes.</p>
            </div>
            <p style="font-size: 13px; color: #94a3b8; text-align: center; margin: 24px 0 0 0;">
              If you did not request this password reset, please ignore this email.
            </p>
          </div>
        `,
      }).catch((err) => console.error("[mail] Reset code email failed:", err.message));
    }

    res.json({
      success: true,
      message: 'If an account exists with this email, a verification code has been sent.',
    });
  },
);

router.post(
  '/reset-password',
  limiter({ limit: 10, minutes: 15 }),
  validate({
    body: z.object({
      email: z.string().trim().email(),
      code: z.string().trim().min(4).max(10),
      newPassword: z.string().min(6).max(100),
    }),
  }),
  async (req, res) => {
    const { email, code, newPassword } = req.valid.body;
    const guest = await db('guests').whereRaw('LOWER(email) = ?', [email.toLowerCase().trim()]).first();

    if (!guest || !guest.reset_token || !guest.reset_expires_at) {
      throw new AppError(400, 'Invalid or expired reset code. Please request a new code.', 'INVALID_RESET_CODE');
    }

    if (new Date(guest.reset_expires_at) < new Date()) {
      throw new AppError(400, 'This reset code has expired. Please request a new code.', 'RESET_CODE_EXPIRED');
    }

    if (guest.reset_token.trim() !== code.trim()) {
      throw new AppError(400, 'Incorrect reset code.', 'INVALID_RESET_CODE');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db('guests').where({ id: guest.id }).update({
      password_hash: passwordHash,
      reset_token: null,
      reset_expires_at: null,
      updated_at: new Date(),
    });

    res.json({
      success: true,
      message: 'Your password has been reset successfully. You can now log in.',
    });
  },
);

/* ---- Signed in ----------------------------------------------------------- */

router.use(authenticateGuest);

router.post('/logout', async (req, res) => {
  await signOut(req.guest.sessionId);
  res.json({ success: true });
});

router.get('/history', async (req, res) => {
  const stays = await db('stays as s')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .leftJoin('room_types as rt', 'rt.id', 'r.room_type_id')
    .where('s.guest_id', req.guest.guestId)
    .orderBy('s.check_in_at', 'desc')
    .select(
      's.id',
      's.reference',
      's.status',
      's.check_in_at',
      's.check_out_at',
      's.adults',
      's.children',
      'r.number as room_number',
      'rt.name as room_type'
    );

  const formatted = stays.map((s) => {
    const arrival = new Date(s.check_in_at);
    const departure = new Date(s.check_out_at);
    const diffMs = Math.max(0, departure.getTime() - arrival.getTime());
    const nights = Math.max(1, Math.round(diffMs / 86_400_000));
    return {
      id: s.id,
      reference: s.reference,
      suiteNumber: s.room_number || 'Unassigned',
      suiteType: s.room_type || 'Deluxe Suite',
      checkInDate: s.check_in_at,
      checkOutDate: s.check_out_at,
      nights,
      status: s.status,
    };
  });

  res.json({ success: true, data: formatted });
});

router.post(
  '/link-booking',
  validate({
    body: z.object({
      bookingCode: z.string().trim().optional(),
      reference: z.string().trim().optional(),
      lastName: z.string().trim().optional(),
      qrToken: z.string().trim().optional(),
      qrData: z.string().trim().optional(),
    }),
  }),
  async (req, res) => {
    let { bookingCode, reference, lastName, qrToken, qrData } = req.valid.body;
    let stay = null;

    // Check if any input is a JSON string or URL
    const rawPayload = qrData || qrToken || bookingCode || reference;
    if (rawPayload && typeof rawPayload === 'string') {
      const trimmed = rawPayload.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const json = JSON.parse(trimmed);
          if (json.qrToken) qrToken = json.qrToken;
          else if (json.token) qrToken = json.token;
          if (json.accessCode) bookingCode = json.accessCode;
          else if (json.code) bookingCode = json.code;
          if (json.reference) reference = json.reference;
          if (json.stayId) {
            stay = await db('stays').where({ id: json.stayId }).first();
          }
        } catch {
          // ignore parse error
        }
      } else if (trimmed.includes('token=')) {
        try {
          const match = trimmed.match(/[?&]token=([^&]+)/);
          if (match && match[1]) qrToken = decodeURIComponent(match[1]);
        } catch {
          // ignore URL error
        }
      }
    }

    if (!stay && qrToken) {
      const hash = lookupHash(qrToken);
      stay = await db('guest_access_codes as c')
        .join('stays as s', 's.id', 'c.stay_id')
        .where({ 'c.kind': 'qr', 'c.lookup_hash': hash })
        .whereNull('c.revoked_at')
        .first('s.*');
    }

    if (!stay && bookingCode) {
      const code = normaliseCode(bookingCode);
      const hash = lookupHash(code);
      stay = await db('guest_access_codes as c')
        .join('stays as s', 's.id', 'c.stay_id')
        .where({ 'c.kind': 'code', 'c.lookup_hash': hash })
        .whereNull('c.revoked_at')
        .first('s.*');
    }

    if (!stay && reference) {
      stay = await db('stays').whereRaw('UPPER(reference) = ?', [reference.trim().toUpperCase()]).first();
      if (stay && lastName) {
        const guests = await db('stay_guests as sg')
          .join('guests as g', 'g.id', 'sg.guest_id')
          .where('sg.stay_id', stay.id)
          .select('g.last_name');
        const match = guests.some((g) => g.last_name && g.last_name.toLowerCase().trim() === lastName.toLowerCase().trim());
        if (!match) stay = null;
      }
    }

    // Fallback: If guest is logged in and already has an active checked-in stay, link that stay
    if (!stay && req.guest?.guestId) {
      stay = await db('stays')
        .where({ guest_id: req.guest.guestId, status: 'checked_in' })
        .orderBy('check_in_at', 'desc')
        .first();
    }

    if (!stay) {
      throw new AppError(404, 'Booking not found with the provided details.', 'BOOKING_NOT_FOUND');
    }

    if (stay.status === 'reserved') {
      throw new AppError(403, 'Your booking is confirmed, but check-in has not started yet. Please check in at the front desk when you arrive.', 'NOT_CHECKED_IN');
    }

    // Link stay to this guest session
    await db('guest_sessions').where({ id: req.guest.sessionId }).update({ stay_id: stay.id });

    // Link guest to stay_guests if not already linked
    const existing = await db('stay_guests').where({ stay_id: stay.id, guest_id: req.guest.guestId }).first();
    if (!existing) {
      await db('stay_guests').insert({ stay_id: stay.id, guest_id: req.guest.guestId });
    }

    const room = stay.room_id ? await db('rooms').where({ id: stay.room_id }).first('number') : null;

    res.json({
      success: true,
      data: {
        stayId: stay.id,
        reference: stay.reference,
        roomNumber: room?.number || 'Pending',
      },
      message: 'Booking linked successfully. Your digital key is now active!',
    });
  },
);

router.get('/me', async (req, res) => {
  const { stayId, roomId, guestId } = req.guest;
  const [stay, guest, room, settings, status, key, eco] = await Promise.all([
    stayId ? db('stays').where({ id: stayId }).first('reference', 'check_in_at', 'check_out_at', 'checked_in_at', 'adults', 'children') : Promise.resolve(null),
    db('guests').where({ id: guestId }).first('id', 'first_name', 'last_name', 'email', 'phone', 'language'),
    roomId
      ? db('rooms as r').join('floors as f', 'f.id', 'r.floor_id').leftJoin('room_types as t', 't.id', 'r.room_type_id').where('r.id', roomId).first('r.number', 'r.image_url', 'f.number as floor', 't.name as room_type')
      : Promise.resolve(null),
    getSettings(),
    roomId ? getRoomStatus(roomId) : Promise.resolve({ dnd: false, cleaningRequested: false, cleaningRequestedAt: null }),
    roomId ? keySummary(stayId, roomId) : Promise.resolve(null),
    roomId ? roomEcoState(roomId) : Promise.resolve(null),
  ]);
  res.json({
    success: true,
    data: {
      hotel: { name: settings.hotel_name, receptionPhone: settings.reception_phone || null, acMinTemp: settings.ac_min_temp, acMaxTemp: settings.ac_max_temp },
      guest: guest ? { id: guest.id, firstName: guest.first_name, lastName: guest.last_name, email: guest.email, phone: guest.phone, language: guest.language } : { firstName: '', lastName: '' },
      stay: stay ? { reference: stay.reference, arrival: stay.check_in_at, departure: stay.check_out_at, checkedInAt: stay.checked_in_at, adults: stay.adults, children: stay.children } : { reference: null, arrival: null, departure: null, checkedInAt: null, adults: 1, children: 0 },
      room: room ? { number: room.number, floor: room.floor, roomType: room.room_type, imageUrl: room.image_url ?? null } : { number: 'Pending', floor: null, roomType: 'Allocated at check-in', imageUrl: null },
      roomStatus: status ? { dnd: status.dnd, cleaningRequested: status.cleaningRequested, cleaningRequestedAt: status.cleaningRequestedAt } : null,
      key,
      eco,
      quickLinks: settings.guest_quick_links,
    },
  });
});

router.put(
  '/push-token',
  validate({ body: z.object({ pushToken: z.string().min(10).max(255), platform: z.enum(['ios', 'android', 'web']) }) }),
  async (req, res) => {
    const { pushToken, platform } = req.valid.body;
    await db('guest_devices')
      .insert({ guest_id: req.guest.guestId, stay_id: req.guest.stayId, push_token: pushToken, platform })
      .onConflict('push_token')
      .merge(['guest_id', 'stay_id', 'platform']);
    res.json({ success: true });
  },
);

/* ---- Digital key ---------------------------------------------------------- */

router.get('/key', async (req, res) => {
  if (!req.guest.stayId || !req.guest.roomId) {
    return res.json({ success: true, data: [] });
  }
  res.json({ success: true, data: await guestKeys(req.guest.stayId, req.guest.roomId) });
});

router.post('/key/unlock', limiter({ limit: 30, minutes: 5, byGuest: true }), validate({ body: z.object({ deviceId: z.number().int().positive().optional() }).optional() }), async (req, res) => {
  if (!req.guest.roomId || !req.guest.stayId) {
    throw badRequest('You must have an active room check-in to use the digital key.');
  }
  res.json({ success: true, data: await remoteUnlock(req.guest, req.valid.body?.deviceId) });
});

/* ---- Room controls and status ---------------------------------------------- */

router.get('/devices', async (req, res) => {
  if (!req.guest.roomId) {
    return res.json({ success: true, data: { eco: false, devices: [] } });
  }
  const [devices, eco] = await Promise.all([listRoomDevices(req.guest.roomId), roomEcoState(req.guest.roomId)]);
  res.json({ success: true, data: { eco, devices } });
});

const commandLimiter = rateLimit({
  windowMs: 60_000,
  limit: async () => (env.isTest ? 1000 : (await getSettings()).guest_commands_per_minute),
  keyGenerator: (req) => `guest-commands:${req.guest.sessionId}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many changes in a short time, please wait a moment' },
});

router.post('/devices/:id/command', commandLimiter, validate({ params: idParam, body: z.record(z.string(), z.any()) }), async (req, res) => {
  if (!req.guest.roomId) {
    throw badRequest('You must have an active room check-in to control room devices.');
  }
  res.json({ success: true, data: await guestCommand(req.guest, req.valid.params.id, req.valid.body) });
});

router.put(
  '/room-status',
  validate({
    body: z
      .object({ dnd: z.boolean().optional(), cleaningRequested: z.boolean().optional(), note: z.string().trim().max(300).optional() })
      .strict()
      .refine((b) => b.dnd !== undefined || b.cleaningRequested !== undefined, { message: 'Send dnd or cleaningRequested' }),
  }),
  async (req, res) => {
    const status = await setRoomStatus(req.guest, req.valid.body);
    res.json({ success: true, data: { dnd: status.dnd, cleaningRequested: status.cleaningRequested, cleaningRequestedAt: status.cleaningRequestedAt } });
  },
);

/* ---- Requests ---------------------------------------------------------------- */

router.get('/requests', async (req, res) => {
  if (!req.guest.stayId) {
    return res.json({ success: true, data: [] });
  }
  res.json({ success: true, data: await listGuestRequests(req.guest.stayId) });
});

router.get('/requests/:id', validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await getGuestRequest(req.guest.stayId, req.valid.params.id) });
});

router.post(
  '/requests',
  limiter({ limit: 20, minutes: 15, byGuest: true }),
  validate({
    body: z.object({
      category: z.enum(REQUEST_CATEGORIES),
      description: z.string().trim().max(1000).optional(),
      preferredAt: z.coerce.date().optional(),
    }),
  }),
  async (req, res) => {
    const { roomId, stayId, guestId } = req.guest;
    if (!roomId || !stayId) {
      throw badRequest('You must have an active room check-in to request room services.');
    }
    const { preferredAt } = req.valid.body;
    if (preferredAt) {
      const stay = await db('stays').where({ id: stayId }).first('check_out_at');
      if (preferredAt < new Date(Date.now() - 5 * 60_000) || preferredAt > new Date(stay.check_out_at)) {
        throw badRequest('Choose a time between now and the end of your stay', [{ field: 'body.preferredAt', message: 'Outside your stay' }]);
      }
    }
    const request = await createGuestRequest({ roomId, stayId, guestId, ...req.valid.body });
    res.status(201).json({ success: true, data: await getGuestRequest(stayId, request.id) });
  },
);

router.post('/requests/:id/cancel', validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await cancelByGuest(req.guest, req.valid.params.id) });
});

/* ---- Feedback ---------------------------------------------------------------- */

const MAX_PHOTOS = 3;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: MAX_PHOTOS, fields: 10 } });

/** Accepts multipart/form-data (with photos) or JSON (without). */
function photoUpload(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  upload.array('photos', MAX_PHOTOS)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = { LIMIT_FILE_SIZE: 'Each photo must be 5 MB or smaller', LIMIT_FILE_COUNT: `Up to ${MAX_PHOTOS} photos`, LIMIT_UNEXPECTED_FILE: `Send photos in the "photos" field, up to ${MAX_PHOTOS}` }[err.code];
      return next(badRequest(msg || err.message));
    }
    next(err);
  });
}

const flag = z.union([z.boolean(), boolish]);

router.post(
  '/feedback',
  limiter({ limit: 5, minutes: 60, byGuest: true }),
  photoUpload,
  validate({
    body: z.object({
      rating: z.coerce.number().int().min(1).max(5),
      category: z.string().trim().max(40).optional(),
      comment: z.string().trim().max(2000).optional(),
      markAsIssue: flag.optional(),
    }),
  }),
  async (req, res) => {
    let { roomId, stayId, guestId } = req.guest;
    if (!stayId) {
      const lastStay = await db('stays').where({ guest_id: guestId }).orderBy('check_in_at', 'desc').first('id', 'room_id');
      if (lastStay) {
        stayId = lastStay.id;
        roomId = lastStay.room_id;
      }
    }
    const { markAsIssue, ...rest } = req.valid.body;
    const fb = await submitFeedback({ roomId, stayId, guestId, ...rest, isIssue: Boolean(markAsIssue), files: req.files ?? [] });
    res.status(201).json({ success: true, data: { id: fb.id, photos: fb.photos, markedAsIssue: fb.isIssue } });
  },
);

/* ---- Preferences (Release 2) ------------------------------------------------- */

router.get('/preferences', async (req, res) => {
  res.json({ success: true, data: await getPreferences(req.guest.guestId) });
});

router.put('/preferences', validate({ body: z.object({ preferences: preferencesSchema, applyNow: z.boolean().optional() }) }), async (req, res) => {
  const saved = await savePreferences(req.guest.guestId, req.valid.body.preferences);
  const applied = req.valid.body.applyNow ? await applyGuestPreferences(req.guest.stayId, { guestId: req.guest.guestId }) : null;
  res.json({ success: true, data: { ...saved, applied } });
});

export default router;
