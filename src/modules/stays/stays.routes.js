import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { validate, idParam, pageQuery, csvEnum, boolish } from '../../core/validate.js';
import * as stays from './stays.service.js';
import * as guests from './guests.service.js';

const actor = (req) => ({ type: 'staff', id: req.staff.id, ip: req.ip });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const guestInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  email: z.email().max(190).optional(),
  phone: z.string().trim().max(40).optional(),
  language: z.string().trim().max(10).optional(),
  vip: z.boolean().optional(),
});
const guestRef = z.union([z.object({ id: z.number().int().positive() }), guestInput]);

/* ---------------------------------------------------------------- stays */

export const staysRouter = Router();

staysRouter.get(
  '/',
  authorize('stays:read'),
  validate({
    query: z.object({
      status: csvEnum(stays.STAY_STATUSES).optional(),
      arrivalDate: dateOnly.optional(),
      departureDate: dateOnly.optional(),
      inHouse: boolish.optional(),
      roomId: z.coerce.number().int().positive().optional(),
      q: z.string().trim().max(100).optional(),
      ...pageQuery,
    }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await stays.listStays(req.valid.query) });
  },
);

staysRouter.get('/:id', authorize('stays:read'), validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await stays.getStay(req.valid.params.id) });
});

staysRouter.post(
  '/',
  authorize('stays:write'),
  validate({
    body: z
      .object({
        guest: guestRef,
        companions: z.array(guestRef).max(10).optional(),
        roomId: z.number().int().positive().optional(),
        roomType: z.string().trim().min(1).max(80).optional(),
        arrival: z.coerce.date().optional(),
        departure: z.coerce.date(),
        adults: z.number().int().min(1).max(20).optional(),
        children: z.number().int().min(0).max(20).optional(),
        notes: z.string().trim().max(1000).optional(),
        checkInNow: z.boolean().optional(),
      })
      .refine((b) => b.checkInNow || b.arrival, { message: 'arrival is required unless checkInNow is true', path: ['arrival'] }),
  }),
  async (req, res) => {
    res.status(201).json({ success: true, data: await stays.createStay(req.valid.body, actor(req)) });
  },
);

staysRouter.patch(
  '/:id',
  authorize('stays:write'),
  validate({
    params: idParam,
    body: z
      .object({
        arrival: z.coerce.date().optional(),
        departure: z.coerce.date().optional(),
        roomId: z.number().int().positive().nullable().optional(),
        roomType: z.string().trim().min(1).max(80).nullable().optional(),
        adults: z.number().int().min(1).max(20).optional(),
        children: z.number().int().min(0).max(20).optional(),
        notes: z.string().trim().max(1000).nullable().optional(),
        addGuests: z.array(guestRef).max(10).optional(),
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await stays.updateStay(req.valid.params.id, req.valid.body, actor(req)) });
  },
);

staysRouter.post('/:id/check-in', authorize('stays:write'), validate({ params: idParam, body: z.object({ roomId: z.number().int().positive().optional() }).optional() }), async (req, res) => {
  res.json({ success: true, data: await stays.checkIn(req.valid.params.id, req.valid.body ?? {}, actor(req)) });
});

staysRouter.post('/:id/check-out', authorize('stays:write'), validate({ params: idParam, body: z.object({ note: z.string().trim().max(1000).optional() }).optional() }), async (req, res) => {
  res.json({ success: true, data: await stays.checkOut(req.valid.params.id, actor(req), req.valid.body ?? {}) });
});

staysRouter.post(
  '/:id/move',
  authorize('stays:write'),
  validate({ params: idParam, body: z.object({ roomId: z.number().int().positive(), reason: z.string().trim().max(500).optional() }) }),
  async (req, res) => {
    res.json({ success: true, data: await stays.moveRoom(req.valid.params.id, req.valid.body, actor(req)) });
  },
);

staysRouter.post('/:id/extend', authorize('stays:write'), validate({ params: idParam, body: z.object({ departure: z.coerce.date() }) }), async (req, res) => {
  res.json({ success: true, data: await stays.extendStay(req.valid.params.id, req.valid.body, actor(req)) });
});

const reasonBody = z.object({ reason: z.string().trim().max(500).optional() }).optional();

staysRouter.post('/:id/cancel', authorize('stays:write'), validate({ params: idParam, body: reasonBody }), async (req, res) => {
  res.json({ success: true, data: await stays.cancelStay(req.valid.params.id, req.valid.body ?? {}, actor(req)) });
});

staysRouter.post('/:id/no-show', authorize('stays:write'), validate({ params: idParam, body: reasonBody }), async (req, res) => {
  res.json({ success: true, data: await stays.markNoShow(req.valid.params.id, req.valid.body ?? {}, actor(req)) });
});

staysRouter.post(
  '/:id/access-code',
  authorize('stays:write'),
  validate({ params: idParam, body: z.object({ signOutDevices: z.boolean().optional(), email: z.boolean().optional() }).optional() }),
  async (req, res) => {
    res.json({ success: true, data: await stays.reissueAccessCode(req.valid.params.id, req.valid.body ?? {}, actor(req)) });
  },
);

staysRouter.get('/:id/qr', authorize('stays:read'), validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await stays.reissueAccessCode(req.valid.params.id, { signOutDevices: false }, actor(req)) });
});

staysRouter.post(
  '/scan-qr',
  authorize('stays:read'),
  validate({
    body: z.object({
      qrData: z.string().trim().min(3).max(2000),
      checkInNow: z.boolean().optional(),
      roomId: z.number().int().positive().optional(),
    }),
  }),
  async (req, res) => {
    res.json({
      success: true,
      data: await stays.scanGuestQr(req.valid.body.qrData, req.valid.body, actor(req)),
    });
  },
);

staysRouter.post('/:id/keys', authorize('stays:write'), validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await stays.reissueKeys(req.valid.params.id, actor(req)) });
});

/* --------------------------------------------------------------- guests */

export const guestsRouter = Router();

guestsRouter.get(
  '/',
  authorize('stays:read'),
  validate({ query: z.object({ q: z.string().trim().max(100).optional(), vip: boolish.optional(), includeAnonymized: boolish.optional(), ...pageQuery }) }),
  async (req, res) => {
    res.json({ success: true, data: await guests.listGuests(req.valid.query) });
  },
);

guestsRouter.get('/:id', authorize('stays:read'), validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await guests.getGuest(req.valid.params.id) });
});

guestsRouter.post('/', authorize('stays:write'), validate({ body: guestInput.extend({ notes: z.string().trim().max(1000).optional() }) }), async (req, res) => {
  res.status(201).json({ success: true, data: await guests.createGuest(req.valid.body, actor(req)) });
});

guestsRouter.patch(
  '/:id',
  authorize('stays:write'),
  validate({
    params: idParam,
    body: guestInput
      .partial()
      .extend({ notes: z.string().trim().max(1000).nullable().optional(), email: z.email().max(190).nullable().optional(), phone: z.string().trim().max(40).nullable().optional() })
      .strict()
      .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await guests.updateGuest(req.valid.params.id, req.valid.body, actor(req)) });
  },
);

guestsRouter.post('/:id/anonymise', authorize('guests:anonymize'), validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await guests.anonymizeGuest(req.valid.params.id, actor(req)) });
});

/* ----------------------------------------------------------- front desk */

export const frontDeskRouter = Router();

frontDeskRouter.get('/today', authorize('stays:read'), async (req, res) => {
  res.json({ success: true, data: await stays.frontDeskToday() });
});

export const availabilityHandler = [
  authorize('stays:read'),
  validate({ query: z.object({ from: z.coerce.date(), to: z.coerce.date(), roomType: z.string().trim().max(80).optional() }) }),
  async (req, res) => {
    res.json({ success: true, data: await stays.availability(req.valid.query) });
  },
];
