import { Router } from 'express';
import * as finance from '../controllers/finance.controller.js';

/** Mounted at /admin/finance */
const router = Router();

router.get('/folios', finance.listFolios);
router.get('/folios/:id', finance.getFolio);
router.post('/folios/:id/charge', finance.postCharge);
router.post('/folios/:id/settle', finance.settle);
router.get('/reports/manager-daily', finance.managerDaily);

export default router;
