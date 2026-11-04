import * as esp32Service from '../services/esp32.service.js';

/** POST /integrations/esp32/telemetry */
export async function postTelemetry(req, res) {
  const remoteIp = req.body?.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
  const cleanIp = remoteIp?.replace(/^::ffff:/, '');
  const ipUrl = cleanIp && cleanIp !== '127.0.0.1' && cleanIp !== '::1' && cleanIp !== 'localhost' ? `http://${cleanIp}` : undefined;

  const data = await esp32Service.processTelemetry({ ...req.body, ip: req.body?.ip || ipUrl });
  res.json({ success: true, data });
}

/** POST /integrations/esp32/alert */
export async function postAlert(req, res) {
  const data = await esp32Service.processEmergencyAlert(req.body);
  res.status(201).json({ success: true, data });
}

/** POST /integrations/esp32/rooms/:roomNumber/assign-hub */
export async function postAssignHub(req, res) {
  const data = await esp32Service.assignHubToRoom({
    roomNumber: req.params.roomNumber,
    deviceId: req.body.deviceId,
    ip: req.body.ip,
  });
  res.json({ success: true, data });
}

/** GET /integrations/esp32/rooms/:roomNumber/status */
export async function getStatus(req, res) {
  const data = await esp32Service.getRoomHardwareStatus(req.params.roomNumber);
  res.json({ success: true, data });
}

