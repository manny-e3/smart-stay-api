import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { validate, pageQuery, boolish } from '../../core/validate.js';
import { listFeedback } from './feedback.service.js';

const router = Router();

router.get(
  '/',
  authorize('feedback:read'),
  validate({
    query: z.object({
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
    }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await listFeedback(req.valid.query) });
  },
);

export default router;
