import * as staysService from '../services/stays.service.js';

const actor = (req) => ({ type: 'staff', id: req.staff.id, ip: req.ip });

/** GET /admin/stays */
export async function list(req, res) {
  res.json({ success: true, data: await staysService.listStays(req.valid.query) });
}

/** GET /admin/stays/:id */
export async function detail(req, res) {
  res.json({ success: true, data: await staysService.getStay(req.valid.params.id) });
}

/** POST /admin/stays */
export async function create(req, res) {
  res.status(201).json({ success: true, data: await staysService.createStay(req.valid.body, actor(req)) });
}

/** PATCH /admin/stays/:id */
export async function update(req, res) {
  res.json({ success: true, data: await staysService.updateStay(req.valid.params.id, req.valid.body, actor(req)) });
}

/** POST /admin/stays/:id/check-in */
export async function checkIn(req, res) {
  res.json({ success: true, data: await staysService.checkIn(req.valid.params.id, req.valid.body ?? {}, actor(req)) });
}

/** POST /admin/stays/:id/check-out */
export async function checkOut(req, res) {
  res.json({ success: true, data: await staysService.checkOut(req.valid.params.id, actor(req), req.valid.body ?? {}) });
}

/** POST /admin/stays/:id/move */
export async function move(req, res) {
  res.json({ success: true, data: await staysService.moveRoom(req.valid.params.id, req.valid.body, actor(req)) });
}

/** POST /admin/stays/:id/extend */
export async function extend(req, res) {
  res.json({ success: true, data: await staysService.extendStay(req.valid.params.id, req.valid.body, actor(req)) });
}

/** POST /admin/stays/:id/cancel */
export async function cancel(req, res) {
  res.json({ success: true, data: await staysService.cancelStay(req.valid.params.id, req.valid.body ?? {}, actor(req)) });
}

/** POST /admin/stays/:id/no-show */
export async function noShow(req, res) {
  res.json({ success: true, data: await staysService.markNoShow(req.valid.params.id, req.valid.body ?? {}, actor(req)) });
}

/** POST /admin/stays/:id/access-code */
export async function reissueAccessCode(req, res) {
  res.json({ success: true, data: await staysService.reissueAccessCode(req.valid.params.id, req.valid.body ?? {}, actor(req)) });
}

/** GET /admin/stays/:id/qr: a fresh QR for the guest. Signed-in phones stay signed in. */
export async function qr(req, res) {
  res.json({ success: true, data: await staysService.reissueAccessCode(req.valid.params.id, { signOutDevices: false }, actor(req)) });
}

/** POST /admin/stays/scan-qr */
export async function scanQr(req, res) {
  res.json({ success: true, data: await staysService.scanGuestQr(req.valid.body.qrData, req.valid.body, actor(req)) });
}

/** POST /admin/stays/:id/keys */
export async function reissueKeys(req, res) {
  res.json({ success: true, data: await staysService.reissueKeys(req.valid.params.id, actor(req)) });
}

/** GET /admin/front-desk/today */
export async function today(req, res) {
  res.json({ success: true, data: await staysService.frontDeskToday() });
}

/** GET /admin/rooms/availability */
export async function availability(req, res) {
  res.json({ success: true, data: await staysService.availability(req.valid.query) });
}
