import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { updateSettingsBody } from '../validators/settings.validator.js';
import * as controller from '../controllers/settings.controller.js';

/** Mounted at /admin/settings */
const router = Router();

router.get('/', authorize('settings:manage'), controller.get);
router.put('/', authorize('settings:manage'), validate({ body: updateSettingsBody }), controller.update);

export default router;
