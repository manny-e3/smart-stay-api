import * as Room from '../models/room.model.js';
import * as Device from '../models/device.model.js';
import * as Energy from '../models/energy.model.js';
import { db } from '../config/db.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { raiseAlert } from './alerts.service.js';
import { notFound } from '../utils/errors.js';

/**
 * Service to process live telemetry and emergency alerts sent by ESP32 In-Room Hubs.
 */

// Helper to ensure an ESP32 adapter exists
async function getOrCreateEsp32Adapter(trx = db) {
  let adapter = await trx('adapters').where({ vendor: 'esp32' }).first();
  if (!adapter) {
    const [id] = await trx('adapters').insert({
      name: 'ESP32 Smart Room Hubs',
      vendor: 'esp32',
      config: JSON.stringify({ timeoutMs: 3000 }),
      is_enabled: true,
      status: 'healthy',
    });
    adapter = await trx('adapters').where({ id }).first();
  }
  return adapter;
}

// Helper to find or auto-provision device records for the room
async function ensureRoomDevices(room, adapterId, deviceIp = null, trx = db) {
  const roomNumber = room.number;
  const desired = [
    { external_id: `light-1-${roomNumber}`, type: 'light', name: 'Ceiling Light', caps: { dimmable: false } },
    { external_id: `light-2-${roomNumber}`, type: 'light', name: 'Bedside Light', caps: { dimmable: false } },
    { external_id: `light-3-${roomNumber}`, type: 'light', name: 'Desk Light', caps: { dimmable: false } },
    { external_id: `light-4-${roomNumber}`, type: 'light', name: 'Bathroom Light', caps: { dimmable: false } },
    { external_id: `meter-pzem-${roomNumber}`, type: 'meter', name: 'AC Power Meter', caps: {} },
    { external_id: `sensor-bme680-${roomNumber}`, type: 'sensor', name: 'Climate & Air Quality Sensor', caps: {} },
    { external_id: `sensor-mq2-${roomNumber}`, type: 'sensor', name: 'Smoke & Gas Sensor', caps: {} },
  ];

  const devices = [];
  for (const d of desired) {
    let dev = await trx('devices').where({ adapter_id: adapterId, external_id: d.external_id }).first();
    const initialCaps = JSON.stringify({ ...d.caps, ...(deviceIp ? { ip: deviceIp } : {}) });

    if (!dev) {
      const [id] = await trx('devices').insert({
        adapter_id: adapterId,
        external_id: d.external_id,
        room_id: room.id,
        type: d.type,
        name: d.name,
        capabilities: initialCaps,
        is_active: true,
      });
      await trx('device_states').insert({
        device_id: id,
        online: true,
        state: JSON.stringify({}),
        last_seen_at: new Date(),
      }).onConflict('device_id').ignore();
      dev = await trx('devices').where({ id }).first();
    } else if (deviceIp) {
      let existingCaps = dev.capabilities;
      if (typeof existingCaps === 'string') {
        try { existingCaps = JSON.parse(existingCaps); } catch {}
      }
      if (!existingCaps?.ip || existingCaps.ip !== deviceIp) {
        const updated = JSON.stringify({ ...(existingCaps || {}), ip: deviceIp });
        await trx('devices').where({ id: dev.id }).update({ capabilities: updated });
        dev.capabilities = updated;
      }
    }
    devices.push(dev);
  }
  return devices;
}

export async function processTelemetry({ roomNumber, bme680, pzem, mq2, battery, relays, ip }) {
  const room = await Room.findByNumber(roomNumber);
  if (!room) {
    throw notFound(`Room ${roomNumber}`);
  }

  const adapter = await getOrCreateEsp32Adapter();
  const devices = await ensureRoomDevices(room, adapter.id, ip);
  const byExternal = new Map(devices.map((d) => [d.external_id, d]));

  const now = new Date();

  // 1. Update BME680 Sensor / Thermostat State
  if (bme680) {
    const bmeDev = byExternal.get(`sensor-bme680-${roomNumber}`);
    if (bmeDev) {
      const state = {
        temperature: bme680.temperature,
        humidity: bme680.humidity,
        pressure: bme680.pressure,
        gasResistance: bme680.gasResistance,
        airQuality: bme680.airQuality,
      };
      await Device.updateState(bmeDev.id, { online: true, state, last_seen_at: now });
      bus.publish(EVENTS.DEVICE_STATE, { deviceId: bmeDev.id, roomId: room.id, online: true, state });
    }
  }

  // 2. Update PZEM-004T Meter State & Save Energy Reading
  if (pzem) {
    const meterDev = byExternal.get(`meter-pzem-${roomNumber}`);
    if (meterDev) {
      const state = {
        voltage: pzem.voltage,
        current: pzem.current,
        power: pzem.power,
        energy: pzem.energy,
        frequency: pzem.frequency,
        pf: pzem.pf,
      };
      await Device.updateState(meterDev.id, { online: Boolean(pzem.online !== false), state, last_seen_at: now });
      bus.publish(EVENTS.DEVICE_STATE, { deviceId: meterDev.id, roomId: room.id, online: true, state });

      // Record hourly kWh into energy_readings table
      if (pzem.energy !== undefined && pzem.energy !== null) {
        const periodStart = new Date(now);
        periodStart.setUTCMinutes(0, 0, 0);
        const kwh = Number((pzem.energy / 1000.0).toFixed(4));
        try {
          await Energy.upsertMany([
            {
              room_id: room.id,
              device_id: meterDev.id,
              period_start: periodStart,
              kwh,
              source: 'esp32_pzem',
            },
          ]);
        } catch (err) {
          console.warn(`[esp32.service] Failed to upsert energy reading: ${err.message}`);
        }
      }
    }
  }

  // 3. Update 4-Channel Relays
  if (relays) {
    const relayMap = [
      { key: 'light1', ext: `light-1-${roomNumber}` },
      { key: 'light2', ext: `light-2-${roomNumber}` },
      { key: 'light3', ext: `light-3-${roomNumber}` },
      { key: 'light4', ext: `light-4-${roomNumber}` },
    ];

    for (const { key, ext } of relayMap) {
      if (relays[key] !== undefined) {
        const dev = byExternal.get(ext);
        if (dev) {
          const state = { on: Boolean(relays[key]) };
          await Device.updateState(dev.id, { online: true, state, last_seen_at: now });
          bus.publish(EVENTS.DEVICE_STATE, { deviceId: dev.id, roomId: room.id, online: true, state });
        }
      }
    }
  }

  // 4. MQ-2 Safety & Smoke Alert Check
  if (mq2) {
    const mqDev = byExternal.get(`sensor-mq2-${roomNumber}`);
    if (mqDev) {
      const state = { smokeValue: mq2.smokeValue, smokeAlert: Boolean(mq2.smokeAlert) };
      await Device.updateState(mqDev.id, { online: true, state, last_seen_at: now });
    }

    if (mq2.smokeAlert || (mq2.smokeValue && mq2.smokeValue > 2000)) {
      await raiseAlert({
        type: 'device_fault',
        severity: 'critical',
        source: 'device',
        title: `Smoke / Combustible Gas Alarm in Room ${roomNumber}`,
        message: `MQ-2 sensor detected critical smoke level: ${mq2.smokeValue}. Local siren activated.`,
        roomId: room.id,
        deviceId: mqDev?.id ?? null,
        adapterId: adapter.id,
      });
    }
  }

  // 5. Battery Health Check
  if (battery) {
    if (battery.lowBattery || (battery.voltage && battery.voltage < 3.3)) {
      await raiseAlert({
        type: 'low_battery',
        severity: 'warning',
        source: 'device',
        title: `Low Controller Backup Battery in Room ${roomNumber}`,
        message: `ESP32 backup battery voltage is low (${Number(battery.voltage).toFixed(2)}V). Please inspect power supply.`,
        roomId: room.id,
        adapterId: adapter.id,
      });
    }
  }

  // Notify clients that room telemetry has refreshed
  bus.publish(EVENTS.BOARD_CHANGED, { roomId: room.id, roomNumber });

  return { ok: true, roomNumber, processedAt: now };
}

export async function processEmergencyAlert({ roomNumber, type, value, message }) {
  const room = await Room.findByNumber(roomNumber);
  if (!room) throw notFound(`Room ${roomNumber}`);

  const adapter = await getOrCreateEsp32Adapter();

  const isSmoke = type === 'smoke_alert' || (type && type.includes('smoke'));
  const severity = isSmoke ? 'critical' : 'warning';
  const title = isSmoke
    ? `URGENT: Smoke / Gas Alarm in Room ${roomNumber}`
    : `Hardware Alert in Room ${roomNumber}: ${type}`;

  const res = await raiseAlert({
    type: isSmoke ? 'device_fault' : type,
    severity,
    source: 'device',
    title,
    message: message || `Sensor reported value: ${value}`,
    roomId: room.id,
    adapterId: adapter.id,
  });

  const alertId = res?.alert?.id || res?.alertId || res;
  bus.publish(EVENTS.BOARD_CHANGED, { roomId: room.id, roomNumber });
  return { ok: true, alertId, roomNumber };
}

export async function getRoomHardwareStatus(roomNumber) {
  const room = await Room.findByNumber(roomNumber);
  if (!room) throw notFound(`Room ${roomNumber}`);

  const devices = await Device.inRoomOfTypes(room.id, ['light', 'meter', 'sensor']);
  return {
    roomNumber: room.number,
    roomId: room.id,
    devices: devices.map((d) => ({
      id: d.id,
      externalId: d.external_id,
      name: d.name,
      type: d.type,
      online: d.online,
      state: d.state,
      lastSeenAt: d.last_seen_at,
    })),
  };
}
