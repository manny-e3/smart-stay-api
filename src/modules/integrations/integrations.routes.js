import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/db.js';
import { sha256 } from '../../core/auth.js';
import { unauthorized } from '../../core/errors.js';
import { validate, idParam } from '../../core/validate.js';
import { DEVICE_EVENT_TYPES, ingestForAdapter } from '../devices/devices.service.js';

/**
 * Inbound webhooks from client device APIs (or a bridge service).
 * Authenticated with the adapter's webhook secret in the X-Adapter-Secret header.
 */
const router = Router();

const eventsBody = z.object({
  events: z
    .array(
      z.object({
        externalId: z.string().min(1).max(120),
        type: z.enum(DEVICE_EVENT_TYPES),
        payload: z.record(z.string(), z.any()).optional(),
        occurredAt: z.coerce.date().optional(),
      }),
    )
    .min(1)
    .max(500),
});

router.post('/adapters/:id/events', validate({ params: idParam, body: eventsBody }), async (req, res) => {
  const adapter = await db('adapters').where({ id: req.valid.params.id, is_enabled: true }).first();
  const given = req.get('x-adapter-secret') || '';
  const ok =
    adapter?.webhook_secret_hash &&
    crypto.timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(adapter.webhook_secret_hash));
  if (!ok) throw unauthorized('Invalid adapter credentials');

  const results = await ingestForAdapter(adapter.id, req.valid.body.events);
  await db('adapters').where({ id: adapter.id }).update({ last_success_at: new Date() });
  res.status(202).json({ success: true, data: { accepted: results.filter((r) => r.accepted).length, results } });
});

export default router;
