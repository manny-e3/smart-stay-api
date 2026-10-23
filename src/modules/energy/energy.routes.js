import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { validate } from '../../core/validate.js';
import { badRequest } from '../../core/errors.js';
import { getEnergy, streamEnergyCsv } from './energy.service.js';

const router = Router();
router.use(authorize('energy:read'));

const MAX_RANGE_DAYS = 400;

const query = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    groupBy: z.enum(['room', 'floor']).default('room'),
    interval: z.enum(['hour', 'day', 'month']).default('day'),
    floor: z
      .string()
      .transform((s) => s.split(',').map(Number).filter(Number.isInteger))
      .optional(),
    roomId: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: 'from must be before to', path: ['from'] });

const checkRange = (q) => {
  if (q.from && q.to && (q.to - q.from) / 86_400_000 > MAX_RANGE_DAYS) throw badRequest(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  if (q.interval === 'hour' && (q.to ?? new Date()) - (q.from ?? new Date(Date.now() - 7 * 86_400_000)) > 31 * 86_400_000) {
    throw badRequest('Hourly data is limited to 31 days');
  }
};

router.get('/', validate({ query }), async (req, res) => {
  checkRange(req.valid.query);
  res.json({ success: true, data: await getEnergy(req.valid.query) });
});

router.get('/export', validate({ query }), async (req, res) => {
  checkRange(req.valid.query);
  await streamEnergyCsv(res, req.valid.query);
});

export default router;
