import { z } from 'zod';
import { pageQuery, boolish } from './common.validator.js';

/** GET /admin/feedback */
export const listFeedbackQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minRating: z.coerce.number().int().min(1).max(5).optional(),
  maxRating: z.coerce.number().int().min(1).max(5).optional(),
  roomId: z.coerce.number().int().positive().optional(),
  floor: z.coerce.number().int().optional(),
  category: z.string().trim().max(40).optional(),
  hasPhotos: boolish.optional(),
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
  ...pageQuery,
});
