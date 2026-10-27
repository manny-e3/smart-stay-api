import * as guestsService from '../services/guests.service.js';

const actor = (req) => ({ type: 'staff', id: req.staff.id, ip: req.ip });

/** GET /admin/guests */
export async function list(req, res) {
  res.json({ success: true, data: await guestsService.listGuests(req.valid.query) });
}

/** GET /admin/guests/:id */
export async function detail(req, res) {
  res.json({ success: true, data: await guestsService.getGuest(req.valid.params.id) });
}

/** POST /admin/guests */
export async function create(req, res) {
  res.status(201).json({ success: true, data: await guestsService.createGuest(req.valid.body, actor(req)) });
}

/** PATCH /admin/guests/:id */
export async function update(req, res) {
  res.json({ success: true, data: await guestsService.updateGuest(req.valid.params.id, req.valid.body, actor(req)) });
}

/** POST /admin/guests/:id/anonymise */
export async function anonymise(req, res) {
  res.json({ success: true, data: await guestsService.anonymizeGuest(req.valid.params.id, actor(req)) });
}
