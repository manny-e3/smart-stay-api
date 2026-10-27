import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as feedbackController from '../controllers/feedback.controller.js';

/**
 * Mounted at /media: private files behind signed, expiring links, so they can be used
 * directly in <img src>. The links come from staff endpoints such as GET /admin/feedback.
 */
const router = Router();

router.get('/feedback-photos/:id', validate({ params: idParam }), feedbackController.photo);

export default router;
