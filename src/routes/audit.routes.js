import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { searchAuditQuery } from '../validators/audit.validator.js';
import * as controller from '../controllers/audit.controller.js';

/** Mounted at /admin/audit */
const router = Router();

router.get('/', authorize('audit:read'), validate({ query: searchAuditQuery }), controller.search);

export default router;
