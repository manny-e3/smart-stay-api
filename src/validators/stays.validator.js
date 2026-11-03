import { z } from 'zod';
import { pageQuery, csvEnum, boolish } from './common.validator.js';
import { guestRef } from './guests.validator.js';
import { STAY_STATUSES } from '../services/stays.service.js';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** GET /admin/stays */
export const listQuery = z.object({
  status: csvEnum(STAY_STATUSES).optional(),
  arrivalDate: dateOnly.optional(),
  departureDate: dateOnly.optional(),
  inHouse: boolish.optional(),
  roomId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});

/** POST /admin/stays */
export const createBody = z
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
  .refine((b) => b.checkInNow || b.arrival, { message: 'arrival is required unless checkInNow is true', path: ['arrival'] });

/** PATCH /admin/stays/:id */
export const updateBody = z
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
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const checkInBody = z.object({ roomId: z.number().int().positive().optional() }).optional();
export const checkOutBody = z.object({ note: z.string().trim().max(1000).optional() }).optional();
export const moveBody = z.object({ roomId: z.number().int().positive(), reason: z.string().trim().max(500).optional() });
export const extendBody = z.object({ departure: z.coerce.date() });
/** Cancel and no-show */
export const reasonBody = z.object({ reason: z.string().trim().max(500).optional() }).optional();
export const accessCodeBody = z.object({ signOutDevices: z.boolean().optional(), email: z.boolean().optional() }).optional();

/** POST /admin/stays/scan-qr */
export const scanQrBody = z.object({
  qrData: z.string().trim().min(3).max(2000),
  checkInNow: z.boolean().optional(),
  roomId: z.number().int().positive().optional(),
});

/** GET /admin/rooms/availability */
export const availabilityQuery = z.object({ from: z.coerce.date(), to: z.coerce.date(), roomType: z.string().trim().max(80).optional() });
