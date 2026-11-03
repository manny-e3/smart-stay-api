import { z } from 'zod';
import { pageQuery, boolish } from './common.validator.js';

/** A guest's profile fields, as sent when creating a guest or a booking. */
export const guestInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  email: z.email().max(190).optional(),
  phone: z.string().trim().max(40).optional(),
  language: z.string().trim().max(10).optional(),
  vip: z.boolean().optional(),
});

/** An existing guest ({ id }) or a new one (profile fields). */
export const guestRef = z.union([z.object({ id: z.number().int().positive() }), guestInput]);

/** GET /admin/guests */
export const listQuery = z.object({ q: z.string().trim().max(100).optional(), vip: boolish.optional(), includeAnonymized: boolish.optional(), ...pageQuery });

/** POST /admin/guests */
export const createBody = guestInput.extend({ notes: z.string().trim().max(1000).optional() });

/** PATCH /admin/guests/:id */
export const updateBody = guestInput
  .partial()
  .extend({ notes: z.string().trim().max(1000).nullable().optional(), email: z.email().max(190).nullable().optional(), phone: z.string().trim().max(40).nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });
