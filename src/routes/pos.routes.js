import { Router } from 'express';
import * as pos from '../controllers/pos.controller.js';

/** Mounted at /admin/pos */
const router = Router();

router.get('/outlets', pos.outlets);
router.get('/categories', pos.categories);
router.get('/menu', pos.menu);
router.get('/reports/daily-z', pos.dailyZ);

router.get('/orders', pos.listOrders);
router.post('/orders', pos.createOrder);
router.get('/orders/:id', pos.getOrder);
router.patch('/orders/:id/status', pos.setStatus);
router.post('/orders/:id/pay', pos.pay);
router.post('/orders/:id/charge-to-room', pos.chargeToRoom);

export default router;
