import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/guests.validator.js';
import * as guests from '../controllers/guests.controller.js';

/** Mounted at /admin/guests */
const router = Router();

router.get('/', authorize('stays:read'), validate({ query: v.listQuery }), guests.list);
router.post('/', authorize('stays:write'), validate({ body: v.createBody }), guests.create);
router.get('/:id', authorize('stays:read'), validate({ params: idParam }), guests.detail);
router.patch('/:id', authorize('stays:write'), validate({ params: idParam, body: v.updateBody }), guests.update);
router.post('/:id/anonymise', authorize('guests:anonymize'), validate({ params: idParam }), guests.anonymise);

export default router;
