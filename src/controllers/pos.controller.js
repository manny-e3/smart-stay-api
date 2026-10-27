import * as posService from '../services/pos.service.js';

const staffId = (req) => req.staff?.id;

/** GET /admin/pos/outlets */
export async function outlets(req, res) {
  res.json({ success: true, data: await posService.listOutlets() });
}

/** GET /admin/pos/categories?outletId= */
export async function categories(req, res) {
  res.json({ success: true, data: await posService.listCategories(req.query) });
}

/** GET /admin/pos/menu?outletId=&categoryId= */
export async function menu(req, res) {
  res.json({ success: true, data: await posService.listMenu(req.query) });
}

/** GET /admin/pos/orders?status=&outletId=&limit= */
export async function listOrders(req, res) {
  res.json({ success: true, data: await posService.listOrders(req.query) });
}

/** POST /admin/pos/orders */
export async function createOrder(req, res) {
  res.status(201).json({ success: true, data: await posService.createOrder(req.body, staffId(req)) });
}

/** GET /admin/pos/orders/:id */
export async function getOrder(req, res) {
  res.json({ success: true, data: await posService.getOrder(req.params.id) });
}

/** PATCH /admin/pos/orders/:id/status */
export async function setStatus(req, res) {
  const { status } = req.body;
  await posService.setOrderStatus(req.params.id, status);
  res.json({ success: true, message: `Order status updated to ${status}` });
}

/** POST /admin/pos/orders/:id/pay */
export async function pay(req, res) {
  await posService.payOrder(req.params.id, req.body, staffId(req));
  res.json({ success: true, message: 'Payment recorded successfully' });
}

/** POST /admin/pos/orders/:id/charge-to-room */
export async function chargeToRoom(req, res) {
  const { order, folio } = await posService.chargeToRoom(req.params.id, req.body, staffId(req));
  res.json({ success: true, message: `Charged $${order.total_amount} to Room Folio ${folio.folio_number}` });
}

/** GET /admin/pos/reports/daily-z */
export async function dailyZ(req, res) {
  res.json({ success: true, data: await posService.dailyZReport() });
}
