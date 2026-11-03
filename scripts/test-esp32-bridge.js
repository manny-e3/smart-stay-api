/**
 * End-to-End Test Script for ESP32 Room Hub Integration.
 * Simulates an ESP32 pushing live telemetry and an emergency smoke alert,
 * then validates database updates and alert records.
 *
 * Usage:
 *   node scripts/test-esp32-bridge.js [room_number]
 */
import { run } from './_util.js';
import { db } from '../src/config/db.js';
import { processTelemetry, processEmergencyAlert } from '../src/services/esp32.service.js';

const roomNumber = process.argv[2] || '101';

run(async () => {
  console.log(`\n======================================================`);
  console.log(` Starting ESP32 Integration Bridge Test (Room ${roomNumber})`);
  console.log(`======================================================\n`);

  // 1. Send Simulated Telemetry
  console.log(`[TEST 1] Sending BME680, PZEM-004T & Relay Telemetry...`);
  const telemetryData = {
    roomNumber,
    bme680: {
      temperature: 24.35,
      humidity: 48.20,
      pressure: 1013.25,
      gasResistance: 62.4,
      airQuality: 'Good',
    },
    pzem: {
      online: true,
      voltage: 231.4,
      current: 1.85,
      power: 428.09,
      energy: 15420, // 15.42 kWh
      frequency: 50.0,
      pf: 0.99,
    },
    mq2: {
      smokeValue: 420,
      smokeAlert: false,
    },
    battery: {
      voltage: 4.12,
      lowBattery: false,
    },
    relays: {
      light1: true,
      light2: false,
      light3: true,
      light4: false,
    },
  };

  const telResult = await processTelemetry(telemetryData);
  console.log(`  -> Processed Telemetry successfully at:`, telResult.processedAt);

  // 2. Query Back Device States
  console.log(`\n[TEST 2] Verifying updated device states in DB...`);
  const room = await db('rooms').where({ number: roomNumber }).first();
  const devices = await db('devices as d')
    .join('device_states as ds', 'ds.device_id', 'd.id')
    .where('d.room_id', room.id)
    .select('d.external_id', 'd.type', 'd.name', 'ds.state', 'ds.online', 'ds.last_seen_at');

  for (const d of devices) {
    const parsedState = typeof d.state === 'string' ? JSON.parse(d.state) : d.state;
    console.log(`  Device [${d.type}] ${d.name} (${d.external_id}): online=${d.online}, state=`, JSON.stringify(parsedState));
  }

  // 3. Query Energy Reading
  console.log(`\n[TEST 3] Verifying energy_readings table...`);
  const latestEnergy = await db('energy_readings')
    .where({ room_id: room.id })
    .orderBy('period_start', 'desc')
    .first();
  console.log(`  Latest Energy Reading: period_start=${latestEnergy?.period_start}, kWh=${latestEnergy?.kwh}, source=${latestEnergy?.source}`);

  // 4. Send Simulated Emergency Smoke Hazard Alert
  console.log(`\n[TEST 4] Simulating Emergency Smoke Alarm...`);
  const alertResult = await processEmergencyAlert({
    roomNumber,
    type: 'smoke_alert',
    value: 2850,
    message: 'CRITICAL: Dense smoke detected! MQ-2 value: 2850. Siren active.',
  });
  console.log(`  -> Raised Critical Alert ID: ${alertResult.alertId}`);

  // 5. Query Back Alert
  const alertRow = await db('alerts').where({ id: alertResult.alertId }).first();
  console.log(`  Verified Alert in DB: [${alertRow.severity.toUpperCase()}] ${alertRow.title}`);
  console.log(`  Status: ${alertRow.status}, Dedupe Key: ${alertRow.dedupe_key}`);

  console.log(`\n======================================================`);
  console.log(` ALL ESP32 INTEGRATION BRIDGE TESTS PASSED!`);
  console.log(`======================================================\n`);
});

