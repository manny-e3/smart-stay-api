import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { energyQuery } from '../validators/energy.validator.js';
import * as controller from '../controllers/energy.controller.js';

/** Mounted at /admin/energy. Manager and admin. */
const router = Router();
router.use(authorize('energy:read'));

router.get('/', validate({ query: energyQuery }), controller.get);
router.get('/export', validate({ query: energyQuery }), controller.exportCsv);

export default router;
