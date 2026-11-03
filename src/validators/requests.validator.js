import { z } from 'zod';
import { pageQuery, csvEnum, boolish } from './common.validator.js';
import { REQUEST_STATUSES, REQUEST_CATEGORIES, REQUEST_PRIORITIES } from '../services/requests.service.js';

/** GET /admin/requests */
export const listRequestsQuery = z.object({
  status: csvEnum(REQUEST_STATUSES).optional(),
  category: csvEnum(REQUEST_CATEGORIES).optional(),
  priority: csvEnum(REQUEST_PRIORITIES).optional(),
  roomId: z.coerce.number().int().positive().optional(),
  assignedTo: z.union([z.literal('me'), z.coerce.number().int().positive()]).optional(),
  unassigned: boolish.optional(),
  escalated: boolish.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageQuery,
});

/** POST /admin/requests */
export const createRequestBody = z.object({
  roomId: z.number().int().positive(),
  category: z.enum(REQUEST_CATEGORIES),
  description: z.string().trim().max(1000).optional(),
  priority: z.enum(REQUEST_PRIORITIES).optional(),
  preferredAt: z.coerce.date().optional(),
});

/** PATCH /admin/requests/:id */
export const updateRequestBody = z
  .object({
    status: z.enum(REQUEST_STATUSES).optional(),
    assignedTo: z.number().int().positive().nullable().optional(),
    priority: z.enum(REQUEST_PRIORITIES).optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });
