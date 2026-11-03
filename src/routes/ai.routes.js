import { Router } from 'express';
import * as ai from '../controllers/ai.controller.js';

/** Mounted at /admin/ai and /guest/ai */
const router = Router();

router.post('/copilot', ai.copilot);
router.post('/guest-chat', ai.guestChat);

export default router;
