import { z } from 'zod';
import { pageQuery, csvEnum } from './common.validator.js';
import { ALERT_TYPES } from '../services/alerts.service.js';

/** GET /admin/alerts */
export const listAlertsQuery = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  type: csvEnum(ALERT_TYPES).optional(),
  severity: csvEnum(['info', 'warning', 'critical']).optional(),
  source: csvEnum(['device', 'guest', 'system']).optional(),
  roomId: z.coerce.number().int().positive().optional(),
  floor: z.coerce.number().int().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageQuery,
});

/** PATCH /admin/alerts/:id */
export const resolveAlertBody = z.object({ status: z.literal('resolved'), note: z.string().trim().min(3, 'A resolution note is required').max(1000) });
