import { z } from 'zod';
import { pageQuery } from './common.validator.js';

/* ---- PMS event payloads (webhook body, stored events, reconciliation) ---- */

const guestSchema = z.object({
  externalId: z.string().max(100).optional(),
  firstName: z.string().min(1).max(80),
  lastName: z.string().max(80).optional(),
  email: z.email().max(190).optional(),
  phone: z.string().max(40).optional(),
  language: z.string().max(10).optional(),
});

export const reservationSchema = z.object({
  externalId: z.string().min(1).max(100),
  reference: z.string().max(20).optional(),
  status: z.enum(['reserved', 'checked_in', 'checked_out', 'cancelled', 'no_show']).optional(),
  roomCode: z.string().max(40).optional(),
  roomType: z.string().max(80).optional(),
  arrival: z.coerce.date(),
  departure: z.coerce.date(),
  adults: z.number().int().min(1).max(20).optional(),
  children: z.number().int().min(0).max(20).optional(),
  notes: z.string().max(1000).optional(),
  guest: guestSchema,
  companions: z.array(guestSchema).max(10).optional(),
});

export const EVENT_TYPES = ['reservation.upsert', 'reservation.cancelled', 'reservation.no_show', 'stay.checked_in', 'stay.checked_out', 'stay.room_moved'];

export const eventSchema = z.object({
  eventId: z.string().min(1).max(190),
  type: z.enum(EVENT_TYPES),
  occurredAt: z.coerce.date().optional(),
  reservation: reservationSchema,
});

/** POST /integrations/pms/:id/events */
export const webhookBody = z.object({ events: z.array(eventSchema).min(1).max(200) });

/* ---- Admin: /admin/pms ---- */

export const createConnectionBody = z.object({
  name: z.string().trim().min(1).max(80),
  vendor: z.string().trim().min(1).max(40),
  config: z.record(z.string(), z.any()).optional(),
  isEnabled: z.boolean().optional(),
});

export const updateConnectionBody = z
  .object({ name: z.string().trim().min(1).max(80).optional(), config: z.record(z.string(), z.any()).optional(), isEnabled: z.boolean().optional() })
  .strict();

export const eventsQuery = z.object({
  connectionId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'processed', 'ignored', 'failed']).optional(),
  ...pageQuery,
});
