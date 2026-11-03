import { Router } from 'express';
import * as inventory from '../controllers/inventory.controller.js';

/** Mounted at /admin/inventory */
const router = Router();

router.get('/categories', inventory.categories);
router.get('/items', inventory.listItems);
router.post('/items', inventory.createItem);
router.post('/transactions', inventory.recordTransaction);
router.post('/rooms/:roomId/minibar-restock', inventory.restockMinibar);

export default router;
