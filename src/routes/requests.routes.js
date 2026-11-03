import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/requests.validator.js';
import * as controller from '../controllers/requests.controller.js';

/** Mounted at /admin/requests */
const router = Router();

router.get('/', authorize('requests:read'), validate({ query: v.listRequestsQuery }), controller.list);
// Static paths go before "/:id" so they aren't read as an id.
router.get('/assignees', authorize('requests:write'), controller.assignees);
router.get('/:id', authorize('requests:read'), validate({ params: idParam }), controller.get);
router.post('/', authorize('requests:write'), validate({ body: v.createRequestBody }), controller.create);
router.patch('/:id', authorize('requests:write'), validate({ params: idParam, body: v.updateRequestBody }), controller.update);

export default router;
