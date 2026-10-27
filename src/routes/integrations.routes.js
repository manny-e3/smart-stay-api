import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import { deviceEventsBody } from '../validators/integrations.validator.js';
import * as controller from '../controllers/integrations.controller.js';

/**
 * Mounted at /integrations: server-to-server webhooks from device vendors.
 * They authenticate with the adapter's webhook secret, not a staff login.
 */
const router = Router();

router.post('/adapters/:id/events', validate({ params: idParam, body: deviceEventsBody }), controller.deviceEvents);

export default router;
