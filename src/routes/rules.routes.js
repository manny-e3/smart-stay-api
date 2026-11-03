import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/rules.validator.js';
import * as controller from '../controllers/rules.controller.js';

/** Mounted at /admin/rules. Admin only. */
const router = Router();
router.use(authorize('rules:manage'));

router.get('/', validate({ query: v.listRulesQuery }), controller.list);
router.get('/:id', validate({ params: idParam }), controller.get);
router.get('/:id/runs', validate({ params: idParam, query: v.listRunsQuery }), controller.runs);
router.post('/', validate({ body: v.ruleInputSchema }), controller.create);
router.patch('/:id', validate({ params: idParam, body: v.updateRuleBody }), controller.update);
router.post('/:id/run', validate({ params: idParam }), controller.runNow);

export default router;
