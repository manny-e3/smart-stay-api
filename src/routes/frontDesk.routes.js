import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import * as stays from '../controllers/stays.controller.js';

/** Mounted at /admin/front-desk */
const router = Router();

router.get('/today', authorize('stays:read'), stays.today);

export default router;
