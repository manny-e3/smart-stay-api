import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/alerts.validator.js';
import * as controller from '../controllers/alerts.controller.js';

/** Mounted at /admin/alerts */
const router = Router();

router.get('/', authorize('alerts:read'), validate({ query: v.listAlertsQuery }), controller.list);
router.get('/:id', authorize('alerts:read'), validate({ params: idParam }), controller.get);
router.patch('/:id', authorize('alerts:resolve'), validate({ params: idParam, body: v.resolveAlertBody }), controller.resolve);

export default router;
