import * as alertsService from '../services/alerts.service.js';

/** GET /admin/alerts */
export async function list(req, res) {
  res.json({ success: true, data: await alertsService.listAlerts(req.valid.query) });
}

/** GET /admin/alerts/:id */
export async function get(req, res) {
  res.json({ success: true, data: await alertsService.getAlert(req.valid.params.id) });
}

/** PATCH /admin/alerts/:id: resolve with a note */
export async function resolve(req, res) {
  const data = await alertsService.resolveAlert(req.valid.params.id, req.valid.body, { id: req.staff.id, ip: req.ip });
  res.json({ success: true, data });
}
