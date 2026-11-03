import { badRequest } from '../utils/errors.js';
import * as guestAppService from '../services/guestApp.service.js';
import { guestKeys, remoteUnlock } from '../services/keys.service.js';
import { guestCommand, listRoomDevices, roomEcoState } from '../services/controls.service.js';
import { setRoomStatus } from '../services/roomStatus.service.js';
import { listGuestRequests, getGuestRequest, cancelByGuest } from '../services/requests.service.js';
import { getPreferences, savePreferences, applyGuestPreferences } from '../services/preferences.service.js';

/**
 * Guest app (mobile and web). req.guest is the signed-in guest: { guestId, stayId, roomId, roomNumber, sessionId }.
 * Every handler works only on that guest's own stay and current room.
 */

/** GET /guest/info (public) */
export async function info(req, res) {
  res.json({ success: true, data: await guestAppService.getInfo() });
}

/** GET /guest/me: the home screen */
export async function home(req, res) {
  res.json({ success: true, data: await guestAppService.getHome(req.guest) });
}

/** GET /guest/history */
export async function history(req, res) {
  res.json({ success: true, data: await guestAppService.getHistory(req.guest.guestId) });
}

/** POST /guest/link-booking */
export async function linkBooking(req, res) {
  res.json({ success: true, data: await guestAppService.linkBooking(req.guest, req.valid.body), message: 'Booking linked successfully. Your digital key is now active!' });
}

/** PUT /guest/push-token */
export async function pushToken(req, res) {
  await guestAppService.savePushToken(req.guest, req.valid.body);
  res.json({ success: true });
}

/* ---- Digital key ---- */

/** GET /guest/key */
export async function keys(req, res) {
  if (!req.guest.stayId || !req.guest.roomId) return res.json({ success: true, data: [] });
  res.json({ success: true, data: await guestKeys(req.guest.stayId, req.guest.roomId) });
}

/** POST /guest/key/unlock */
export async function unlock(req, res) {
  if (!req.guest.roomId || !req.guest.stayId) throw badRequest('You must have an active room check-in to use the digital key.');
  res.json({ success: true, data: await remoteUnlock(req.guest, req.valid.body?.deviceId) });
}

/* ---- Room controls and status ---- */

/** GET /guest/devices */
export async function devices(req, res) {
  if (!req.guest.roomId) return res.json({ success: true, data: { eco: false, devices: [] } });
  const [list, eco] = await Promise.all([listRoomDevices(req.guest.roomId), roomEcoState(req.guest.roomId)]);
  res.json({ success: true, data: { eco, devices: list } });
}

/** POST /guest/devices/:id/command */
export async function deviceCommand(req, res) {
  if (!req.guest.roomId) throw badRequest('You must have an active room check-in to control room devices.');
  res.json({ success: true, data: await guestCommand(req.guest, req.valid.params.id, req.valid.body) });
}

/** PUT /guest/room-status: Do Not Disturb and cleaning */
export async function roomStatus(req, res) {
  const status = await setRoomStatus(req.guest, req.valid.body);
  res.json({ success: true, data: { dnd: status.dnd, cleaningRequested: status.cleaningRequested, cleaningRequestedAt: status.cleaningRequestedAt } });
}

/* ---- Requests ---- */

/** GET /guest/requests */
export async function listRequests(req, res) {
  if (!req.guest.stayId) return res.json({ success: true, data: [] });
  res.json({ success: true, data: await listGuestRequests(req.guest.stayId) });
}

/** GET /guest/requests/:id */
export async function getRequest(req, res) {
  res.json({ success: true, data: await getGuestRequest(req.guest.stayId, req.valid.params.id) });
}

/** POST /guest/requests */
export async function createRequest(req, res) {
  res.status(201).json({ success: true, data: await guestAppService.createRequest(req.guest, req.valid.body) });
}

/** POST /guest/requests/:id/cancel */
export async function cancelRequest(req, res) {
  res.json({ success: true, data: await cancelByGuest(req.guest, req.valid.params.id) });
}

/* ---- Feedback ---- */

/** POST /guest/feedback (JSON or multipart with photos) */
export async function feedback(req, res) {
  res.status(201).json({ success: true, data: await guestAppService.leaveFeedback(req.guest, req.valid.body, req.files ?? []) });
}

/* ---- Preferences ---- */

/** GET /guest/preferences */
export async function preferences(req, res) {
  res.json({ success: true, data: await getPreferences(req.guest.guestId) });
}

/** PUT /guest/preferences */
export async function updatePreferences(req, res) {
  const saved = await savePreferences(req.guest.guestId, req.valid.body.preferences);
  const applied = req.valid.body.applyNow ? await applyGuestPreferences(req.guest.stayId, { guestId: req.guest.guestId }) : null;
  res.json({ success: true, data: { ...saved, applied } });
}
