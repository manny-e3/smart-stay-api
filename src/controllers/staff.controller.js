import * as staffService from '../services/staff.service.js';

const actor = (req) => ({ id: req.staff.id, ip: req.ip });

/** GET /admin/staff */
export async function list(req, res) {
  res.json({ success: true, data: await staffService.listStaff(req.valid.query) });
}

/** GET /admin/staff/:id */
export async function get(req, res) {
  res.json({ success: true, data: await staffService.getStaff(req.valid.params.id) });
}

/** POST /admin/staff */
export async function create(req, res) {
  res.status(201).json({ success: true, data: await staffService.createStaff(req.valid.body, actor(req)) });
}

/** PATCH /admin/staff/:id */
export async function update(req, res) {
  res.json({ success: true, data: await staffService.updateStaff(req.valid.params.id, req.valid.body, actor(req)) });
}
