import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/db.js';
import { authorize, sha256 } from '../../core/auth.js';
import { unauthorized } from '../../core/errors.js';
import { validate, idParam, pageQuery } from '../../core/validate.js';
import * as pms from './pms.service.js';

const actor = (req) => ({ id: req.staff.id, ip: req.ip });

/* ---- Admin: /admin/pms ------------------------------------------------ */

export const pmsAdminRouter = Router();
pmsAdminRouter.use(authorize('pms:manage'));

pmsAdminRouter.get('/connections', async (req, res) => {
  res.json({ success: true, data: await pms.listConnections() });
});

pmsAdminRouter.post(
  '/connections',
  validate({ body: z.object({ name: z.string().trim().min(1).max(80), vendor: z.string().trim().min(1).max(40), config: z.record(z.string(), z.any()).optional(), isEnabled: z.boolean().optional() }) }),
  async (req, res) => {
    res.status(201).json({ success: true, data: await pms.createConnection(req.valid.body, actor(req)) });
  },
);

pmsAdminRouter.patch(
  '/connections/:id',
  validate({
    params: idParam,
    body: z.object({ name: z.string().trim().min(1).max(80).optional(), config: z.record(z.string(), z.any()).optional(), isEnabled: z.boolean().optional() }).strict(),
  }),
  async (req, res) => {
    res.json({ success: true, data: await pms.updateConnection(req.valid.params.id, req.valid.body, actor(req)) });
  },
);

pmsAdminRouter.post('/connections/:id/secret', validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await pms.rotateSecret(req.valid.params.id, actor(req)) });
});

pmsAdminRouter.post('/connections/:id/sync', validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await pms.syncNow(req.valid.params.id, actor(req)) });
});

pmsAdminRouter.get(
  '/events',
  validate({ query: z.object({ connectionId: z.coerce.number().int().positive().optional(), status: z.enum(['pending', 'processed', 'ignored', 'failed']).optional(), ...pageQuery }) }),
  async (req, res) => {
    res.json({ success: true, data: await pms.listEvents(req.valid.query) });
  },
);

pmsAdminRouter.post('/events/:id/retry', validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await pms.retryEvent(req.valid.params.id) });
});

/* ---- Webhook: /integrations/pms/:id/events ---------------------------- */

export const pmsWebhookRouter = Router();

pmsWebhookRouter.post(
  '/:id/events',
  validate({ params: idParam, body: z.object({ events: z.array(pms.eventSchema).min(1).max(200) }) }),
  async (req, res) => {
    const connection = await db('pms_connections').where({ id: req.valid.params.id, is_enabled: true }).first();
    const given = req.get('x-pms-secret') || '';
    const ok = connection?.webhook_secret_hash && crypto.timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(connection.webhook_secret_hash));
    if (!ok) throw unauthorized('Invalid PMS credentials');
    const results = await pms.ingestEvents(connection, req.valid.body.events);
    res.status(202).json({ success: true, data: { results } });
  },
);
