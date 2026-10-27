import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { listFeedbackQuery } from '../validators/feedback.validator.js';
import * as controller from '../controllers/feedback.controller.js';

/** Mounted at /admin/feedback */
const router = Router();

router.get('/', authorize('feedback:read'), validate({ query: listFeedbackQuery }), controller.list);

export default router;
