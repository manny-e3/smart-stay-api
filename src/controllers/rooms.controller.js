import { can } from '../config/permissions.js';
import * as boardService from '../services/board.service.js';
import * as roomsService from '../services/rooms.service.js';

const actor = (req) => ({ id: req.staff.id, ip: req.ip });

/** GET /admin/rooms/board */
export async function board(req, res) {
  res.json({ success: true, data: await boardService.getBoard(req.valid.query) });
}

/** GET /admin/rooms/:id. Guest contact details only for roles that manage stays. */
export async function detail(req, res) {
  const includeContact = can(req.staff.role, 'stays:read');
  res.json({ success: true, data: await boardService.getRoomDetail(req.valid.params.id, { includeContact }) });
}

/** POST /admin/rooms */
export async function create(req, res) {
  res.status(201).json({ success: true, data: await roomsService.createRoom(req.valid.body, actor(req)) });
}

/** PATCH /admin/rooms/:id */
export async function update(req, res) {
  res.json({ success: true, data: await roomsService.updateRoom(req.valid.params.id, req.valid.body, actor(req)) });
}

/** DELETE /admin/rooms/:id */
export async function remove(req, res) {
  res.json({ success: true, data: await roomsService.deleteRoom(req.valid.params.id, actor(req)) });
}

/** POST /admin/rooms/upload */
export async function uploadPhoto(req, res) {
  res.json({ success: true, data: await roomsService.uploadRoomPhoto(req.valid.body.dataUrl) });
}

/** GET /admin/rooms/:id/devices */
export async function listDevices(req, res) {
  res.json({ success: true, data: await roomsService.getRoomDevicesList(req.valid.params.id) });
}

/** POST /admin/rooms/:id/devices */
export async function addDevice(req, res) {
  res.status(201).json({ success: true, data: await roomsService.addDeviceToRoom(req.valid.params.id, req.valid.body, actor(req)) });
}

/** PATCH /admin/rooms/:id/devices/:deviceId */
export async function updateDevice(req, res) {
  const { id, deviceId } = req.valid.params;
  res.json({ success: true, data: await roomsService.updateRoomDevice(id, deviceId, req.valid.body, actor(req)) });
}

/** DELETE /admin/rooms/:id/devices/:deviceId */
export async function removeDevice(req, res) {
  const { id, deviceId } = req.valid.params;
  res.json({ success: true, data: await roomsService.deleteRoomDevice(id, deviceId, actor(req)) });
}
