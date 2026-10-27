/**
 * Sends a fake device event through the real pipeline, for the test room and demos.
 *
 *   node scripts/device-event.js <room> <device_type> <event_type> [payload-json]
 *
 * Examples:
 *   node scripts/device-event.js 101 lock fault '{"message":"Motor jammed"}'
 *   node scripts/device-event.js 101 lock offline
 *   node scripts/device-event.js 101 lock unlock '{"method":"mobile_key","guestId":1}'
 *   node scripts/device-event.js 101 sensor presence '{"presence":false}'
 *
 * The running API only sees changes made here on its next board refresh, because events
 * from this script are published inside this process. Use the webhook endpoint to test live updates.
 */
import { run } from './_util.js';
import * as Device from '../src/models/device.model.js';
import { DEVICE_EVENT_TYPES, ingestEvent } from '../src/services/devices.service.js';

const [room, deviceType, type, payload] = process.argv.slice(2);

run(async () => {
  if (!room || !deviceType || !DEVICE_EVENT_TYPES.includes(type)) {
    console.error(`Usage: node scripts/device-event.js <room> <device_type> <${DEVICE_EVENT_TYPES.join('|')}> [payload-json]`);
    process.exitCode = 1;
    return;
  }
  const device = await Device.findActiveInRoomByNumber(room, deviceType);
  if (!device) throw new Error(`No active ${deviceType} in room ${room}`);
  await ingestEvent(device, { type, payload: payload ? JSON.parse(payload) : {} });
  await new Promise((r) => setTimeout(r, 300));
  console.log(`Sent ${type} for ${deviceType} in room ${room}`);
});
