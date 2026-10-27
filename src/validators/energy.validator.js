import { z } from 'zod';

/** GET /admin/energy and /admin/energy/export */
export const energyQuery = z
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
