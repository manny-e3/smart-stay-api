import * as inventoryService from '../services/inventory.service.js';

const staffId = (req) => req.staff?.id;

/** GET /admin/inventory/categories */
export async function categories(req, res) {
  res.json({ success: true, data: await inventoryService.listCategories() });
}

/** GET /admin/inventory/items?categoryId=&lowStock=true */
export async function listItems(req, res) {
  res.json({ success: true, data: await inventoryService.listItems(req.query) });
}

/** POST /admin/inventory/items */
export async function createItem(req, res) {
  res.status(201).json({ success: true, data: await inventoryService.createItem(req.body) });
}

/** POST /admin/inventory/transactions */
export async function recordTransaction(req, res) {
  const newStock = await inventoryService.recordTransaction(req.body, staffId(req));
  res.json({ success: true, message: `Inventory adjusted. New stock: ${newStock}` });
}

/** POST /admin/inventory/rooms/:roomId/minibar-restock */
export async function restockMinibar(req, res) {
  const room = await inventoryService.restockMinibar(req.params.roomId, req.body, staffId(req));
  res.json({ success: true, message: `Minibar for Room ${room.number} restocked and updated.` });
}
