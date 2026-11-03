import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/staff.validator.js';
import * as controller from '../controllers/staff.controller.js';

/** Mounted at /admin/staff. Admin only. */
const router = Router();
router.use(authorize('staff:manage'));

router.get('/', validate({ query: v.listStaffQuery }), controller.list);
router.get('/:id', validate({ params: idParam }), controller.get);
router.post('/', validate({ body: v.createStaffBody }), controller.create);
router.patch('/:id', validate({ params: idParam, body: v.updateStaffBody }), controller.update);

export default router;
