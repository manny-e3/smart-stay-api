/**
 * Registers an ESP32 In-Room Hub for a specific room number.
 * Creates the ESP32 adapter if not present and provisions:
 *   - 4x Light devices (Ceiling, Bedside, Desk, Bathroom)
 *   - 1x AC Power Meter (PZEM-004T)
 *   - 1x Climate & VOC Sensor (BME680)
 *   - 1x Safety Sensor (MQ-2 Smoke & Gas)
 *
 * Usage:
 *   node scripts/register-esp32-room.js <room_number> [device_ip]
 * Example:
 *   node scripts/register-esp32-room.js 101 http://192.168.1.150
 */
import { run } from './_util.js';
import { db } from '../src/config/db.js';
import * as Room from '../src/models/room.model.js';

const [roomNumber, deviceIp] = process.argv.slice(2);

run(async () => {
  if (!roomNumber) {
    console.error('Usage: node scripts/register-esp32-room.js <room_number> [device_ip]');
    process.exitCode = 1;
    return;
  }

  const room = await Room.findByNumber(roomNumber);
  if (!room) {
    console.error(`Error: Room ${roomNumber} does not exist in the database.`);
    process.exitCode = 1;
    return;
  }

  // Ensure ESP32 adapter exists
  let adapter = await db('adapters').where({ vendor: 'esp32' }).first();
  if (!adapter) {
    const [adapterId] = await db('adapters').insert({
      name: 'ESP32 Smart Room Hubs',
      vendor: 'esp32',
      config: JSON.stringify({ ...(deviceIp ? { baseUrl: deviceIp } : {}), timeoutMs: 4000 }),
      is_enabled: true,
      status: 'healthy',
    });
    adapter = await db('adapters').where({ id: adapterId }).first();
    console.log(`Created ESP32 adapter (ID: ${adapter.id})`);
  }

  const desiredDevices = [
    { external_id: `light-1-${roomNumber}`, type: 'light', name: 'Ceiling Light', caps: { dimmable: false } },
    { external_id: `light-2-${roomNumber}`, type: 'light', name: 'Bedside Light', caps: { dimmable: false } },
    { external_id: `light-3-${roomNumber}`, type: 'light', name: 'Desk Light', caps: { dimmable: false } },
    { external_id: `light-4-${roomNumber}`, type: 'light', name: 'Bathroom Light', caps: { dimmable: false } },
    { external_id: `meter-pzem-${roomNumber}`, type: 'meter', name: 'AC Power Meter', caps: {} },
    { external_id: `sensor-bme680-${roomNumber}`, type: 'sensor', name: 'Climate & Air Quality', caps: {} },
    { external_id: `sensor-mq2-${roomNumber}`, type: 'sensor', name: 'MQ-2 Smoke & Gas Detector', caps: {} },
  ];

  let createdCount = 0;
  for (const d of desiredDevices) {
    const existing = await db('devices')
      .where({ adapter_id: adapter.id, external_id: d.external_id })
      .first();

    if (!existing) {
      const [deviceId] = await db('devices').insert({
        adapter_id: adapter.id,
        external_id: d.external_id,
        room_id: room.id,
        type: d.type,
        name: d.name,
        capabilities: JSON.stringify({ ...d.caps, ...(deviceIp ? { ip: deviceIp } : {}) }),
        is_active: true,
      });

      await db('device_states').insert({
        device_id: deviceId,
        online: true,
        state: JSON.stringify(d.type === 'light' ? { on: false } : {}),
        last_seen_at: new Date(),
      });
      createdCount++;
      console.log(`  + Provisioned device [${d.type}] ${d.name} (${d.external_id})`);
    } else {
      console.log(`  = Already registered: ${d.name} (${d.external_id})`);
    }
  }

  console.log(`\nSuccessfully registered ESP32 hub for Room ${roomNumber}. Total new devices: ${createdCount}`);
});

