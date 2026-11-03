import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/pms.validator.js';
import * as pms from '../controllers/pms.controller.js';

/** Admin screens. Mounted at /admin/pms */
export const pmsAdminRouter = Router();
pmsAdminRouter.use(authorize('pms:manage'));

pmsAdminRouter.get('/connections', pms.listConnections);
pmsAdminRouter.post('/connections', validate({ body: v.createConnectionBody }), pms.createConnection);
pmsAdminRouter.patch('/connections/:id', validate({ params: idParam, body: v.updateConnectionBody }), pms.updateConnection);
pmsAdminRouter.post('/connections/:id/secret', validate({ params: idParam }), pms.rotateSecret);
pmsAdminRouter.post('/connections/:id/sync', validate({ params: idParam }), pms.syncNow);
pmsAdminRouter.get('/events', validate({ query: v.eventsQuery }), pms.listEvents);
pmsAdminRouter.post('/events/:id/retry', validate({ params: idParam }), pms.retryEvent);

/** Webhook the PMS calls. No staff login: checked with the connection's secret. Mounted at /integrations/pms */
export const pmsWebhookRouter = Router();

pmsWebhookRouter.post('/:id/events', validate({ params: idParam, body: v.webhookBody }), pms.webhook);
