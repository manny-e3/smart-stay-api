import { Router } from 'express';
import * as procurement from '../controllers/procurement.controller.js';

/** Mounted at /admin/procurement */
const router = Router();

router.get('/vendors', procurement.listVendors);
router.post('/vendors', procurement.createVendor);
router.get('/orders', procurement.listOrders);
router.post('/orders', procurement.createOrder);
router.get('/orders/:id', procurement.getOrder);
router.post('/orders/:id/receive', procurement.receive);

export default router;
