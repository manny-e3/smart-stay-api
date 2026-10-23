import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { validate, idParam, pageQuery, csvEnum } from '../../core/validate.js';
import * as alerts from './alerts.service.js';

const router = Router();

const ALERT_TYPES = [
  'device_offline', 'device_fault', 'low_battery', 'adapter_down', 'guest_issue', 'command_failed',
  'key_failed', 'key_revoke_failed', 'pms_sync_failed',
];

router.get(
  '/',
  authorize('alerts:read'),
  validate({
    query: z.object({
      status: z.enum(['open', 'resolved']).optional(),
      type: csvEnum(ALERT_TYPES).optional(),
      severity: csvEnum(['info', 'warning', 'critical']).optional(),
      source: csvEnum(['device', 'guest', 'system']).optional(),
      roomId: z.coerce.number().int().positive().optional(),
      floor: z.coerce.number().int().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      ...pageQuery,
    }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await alerts.listAlerts(req.valid.query) });
  },
);

router.get('/:id', authorize('alerts:read'), validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await alerts.getAlert(req.valid.params.id) });
});

router.patch(
  '/:id',
  authorize('alerts:resolve'),
  validate({
    params: idParam,
    body: z.object({ status: z.literal('resolved'), note: z.string().trim().min(3, 'A resolution note is required').max(1000) }),
  }),
  async (req, res) => {
    const data = await alerts.resolveAlert(req.valid.params.id, req.valid.body, { id: req.staff.id, ip: req.ip });
    res.json({ success: true, data });
  },
);

export default router;
