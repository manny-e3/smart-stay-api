import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { db } from '../../config/db.js';
import { badRequest } from '../../core/errors.js';
import { validate, idParam, boolish } from '../../core/validate.js';
import { authenticateGuest, signIn, signOut } from './guest.auth.js';
import { getRoomStatus, setRoomStatus } from './roomStatus.service.js';
import { getPreferences, savePreferences, preferencesSchema, applyGuestPreferences } from './preferences.service.js';
import { guestKeys, keySummary, remoteUnlock } from '../keys/keys.service.js';
import { guestCommand, listRoomDevices, roomEcoState } from '../controls/controls.service.js';
import { createGuestRequest, listGuestRequests, getGuestRequest, cancelByGuest, REQUEST_CATEGORIES } from '../requests/requests.service.js';
import { submitFeedback } from '../feedback/feedback.service.js';
import { getSettings } from '../settings/settings.service.js';

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
      z.object({ bookingCode: z.string().trim().min(6).max(20) }).strict(),
      z.object({ qrToken: z.string().trim().min(16).max(200) }).strict(),
      z.object({ reference: z.string().trim().min(4).max(20), lastName: z.string().trim().min(1).max(80) }).strict(),
    ]),
  }),
  async (req, res) => {
    res.status(201).json({ success: true, data: await signIn(req.valid.body, meta(req)) });
  },
);

/* ---- Signed in ----------------------------------------------------------- */

router.use(authenticateGuest);

router.post('/logout', async (req, res) => {
  await signOut(req.guest.sessionId);
  res.json({ success: true });
});

router.get('/me', async (req, res) => {
  const { stayId, roomId, guestId } = req.guest;
  const [stay, guest, room, settings, status, key, eco] = await Promise.all([
    db('stays').where({ id: stayId }).first('reference', 'check_in_at', 'check_out_at', 'checked_in_at', 'adults', 'children'),
    db('guests').where({ id: guestId }).first('first_name', 'last_name', 'language'),
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
      guest: { firstName: guest.first_name, lastName: guest.last_name, language: guest.language },
      stay: { reference: stay.reference, arrival: stay.check_in_at, departure: stay.check_out_at, checkedInAt: stay.checked_in_at, adults: stay.adults, children: stay.children },
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
  res.json({ success: true, data: await guestKeys(req.guest.stayId, req.guest.roomId) });
});

router.post('/key/unlock', limiter({ limit: 30, minutes: 5, byGuest: true }), validate({ body: z.object({ deviceId: z.number().int().positive().optional() }).optional() }), async (req, res) => {
  res.json({ success: true, data: await remoteUnlock(req.guest, req.valid.body?.deviceId) });
});

/* ---- Room controls and status ---------------------------------------------- */

router.get('/devices', async (req, res) => {
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
    const { roomId, stayId, guestId } = req.guest;
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
