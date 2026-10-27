import * as procurementService from '../services/procurement.service.js';

const staffId = (req) => req.staff?.id;

/** GET /admin/procurement/vendors */
export async function listVendors(req, res) {
  res.json({ success: true, data: await procurementService.listVendors() });
}

/** POST /admin/procurement/vendors */
export async function createVendor(req, res) {
  res.status(201).json({ success: true, data: await procurementService.createVendor(req.body) });
}

/** GET /admin/procurement/orders?status= */
export async function listOrders(req, res) {
  res.json({ success: true, data: await procurementService.listOrders(req.query) });
}

/** POST /admin/procurement/orders */
export async function createOrder(req, res) {
  res.status(201).json({ success: true, data: await procurementService.createOrder(req.body, staffId(req)) });
}

/** GET /admin/procurement/orders/:id */
export async function getOrder(req, res) {
  res.json({ success: true, data: await procurementService.getOrder(req.params.id) });
}

/** POST /admin/procurement/orders/:id/receive */
export async function receive(req, res) {
  await procurementService.receiveOrder(req.params.id, req.body, staffId(req));
  res.json({ success: true, message: `Goods received and added to inventory ledger.` });
}
