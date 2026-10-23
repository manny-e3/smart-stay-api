import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { validate } from '../../core/validate.js';
import { getSettings, updateSettings } from './settings.service.js';

const router = Router();

router.get('/', authorize('settings:manage'), async (req, res) => {
  res.json({ success: true, data: await getSettings() });
});

// Accepts the full settings object or only the fields being changed; the merged result is validated.
router.put('/', authorize('settings:manage'), validate({ body: z.record(z.string(), z.any()) }), async (req, res) => {
  res.json({ success: true, data: await updateSettings(req.valid.body, { staffId: req.staff.id, ip: req.ip }) });
});

export default router;
