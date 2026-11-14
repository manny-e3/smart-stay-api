import * as esp32Service from '../services/esp32.service.js';
import { isReachableHubHost } from '../integrations/devices/esp32.adapter.js';

/** POST /integrations/esp32/telemetry. Answers at once; the readings are applied in the background. */
export async function postTelemetry(req, res) {
  const remoteIp = req.body?.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
  const cleanIp = remoteIp?.replace(/^::ffff:/, '');
  // Only remember the hub's address when the API can reach it (same LAN). Behind a MiFi or the
  // hotel router the address seen here is the router's public one, which never answers.
  const ipUrl = cleanIp && isReachableHubHost(`http://${cleanIp}`) ? `http://${cleanIp}` : undefined;

  console.log(`[ESP32 Telemetry] Received from ${cleanIp || 'unknown'} for Room "${req.body?.roomNumber}", Device: "${req.body?.deviceId}"`);
  const data = await esp32Service.acceptTelemetry({ ...req.body, ip: ipUrl });
  res.json({ success: true, data });
}

/** POST /integrations/esp32/alert */
export async function postAlert(req, res) {
  console.log(`[ESP32 Alert] Received emergency alert for Room "${req.body?.roomNumber}"`, req.body);
  const data = await esp32Service.processEmergencyAlert(req.body);
  res.status(201).json({ success: true, data });
}

/** POST /integrations/esp32/rooms/:roomNumber/assign-hub */
export async function postAssignHub(req, res) {
  console.log(`[ESP32 Assign] Linking hub "${req.body?.deviceId}" to Room "${req.params.roomNumber}"`);
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

/** POST /integrations/esp32/rooms/:roomNumber/actuator */
export async function postToggleActuator(req, res) {
  console.log(`[ESP32 Actuator] Toggle Room "${req.params.roomNumber}", Device: "${req.body?.deviceKey}", State: ${req.body?.state}`);
  const data = await esp32Service.toggleActuator({
    roomNumber: req.params.roomNumber,
    deviceKey: req.body.deviceKey,
    state: req.body.state,
  });
  res.json({ success: data?.ok !== false, data });
}

/** GET /integrations/esp32/rooms/:roomNumber/commands (Fast poll for pending actuator toggles) */
export async function getPendingCommands(req, res) {
  const commands = esp32Service.popCommands(req.params.roomNumber);
  res.json({ success: true, data: { commands } });
}

