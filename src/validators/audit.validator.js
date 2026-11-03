import { z } from 'zod';
import { pageQuery } from './common.validator.js';

/** GET /admin/audit */
export const searchAuditQuery = z.object({
  staffId: z.coerce.number().int().positive().optional(),
  actorType: z.enum(['staff', 'guest', 'system']).optional(),
  action: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(40).optional(),
  roomId: z.coerce.number().int().positive().optional(),
  roomNumber: z.string().trim().max(20).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(100).optional(),
  ...pageQuery,
});
