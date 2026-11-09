import * as Room from '../models/room.model.js';
import * as Device from '../models/device.model.js';
import * as Energy from '../models/energy.model.js';
import { db } from '../config/db.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { raiseAlert } from './alerts.service.js';
import { notFound } from '../utils/errors.js';
import { adapterFor } from '../integrations/devices/index.js';

/**
 * Service to process live telemetry and emergency alerts sent by ESP32 In-Room Hubs.
 */

// In-memory command queue for reliable cloud-to-hardware actuator delivery
const g_commandQueue = new Map(); // roomNumber -> Array<{ id, device, deviceKey, state, createdAt }>

// When a relay was toggled from the dashboard, telemetry that was already on its way (built before
// the hub received the command) still carries the OLD relay state and would flip the tile back.
// Relay states reported within this window after a command are ignored for that relay.
const COMMAND_SETTLE_MS = 10000;
const g_recentCommands = new Map(); // `${room}:${relay}` -> timestamp ms

function canonicalRelay(key) {
  const k = String(key || '').toLowerCase().replace(/-/g, '');
  if (k === 'light' || k === 'light1') return 'light';
  if (k === 'ac' || k === 'light2') return 'ac';
  if (k === 'tv' || k === 'light3') return 'tv';
  if (k === 'fridge' || k === 'light4') return 'fridge';
  return k;
}

function isRelaySettling(roomNumber, relay) {
  const t = g_recentCommands.get(`${roomNumber}:${relay}`);
  return t !== undefined && Date.now() - t < COMMAND_SETTLE_MS;
}

export function enqueueCommand(roomNumber, deviceKey, state) {
  const norm = String(roomNumber).replace(/Room\s*/i, '').trim();
  g_recentCommands.set(`${norm}:${canonicalRelay(deviceKey)}`, Date.now());
  if (!g_commandQueue.has(norm)) {
    g_commandQueue.set(norm, []);
  }
  const cmd = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    device: deviceKey,
    deviceKey,
    state: Boolean(state),
    createdAt: new Date().toISOString(),
  };
  const list = g_commandQueue.get(norm);
  list.push(cmd);
  if (list.length > 20) list.shift();
  return cmd;
}

export function popCommands(roomNumber) {
  const norm = String(roomNumber).replace(/Room\s*/i, '').trim();
  const list = g_commandQueue.get(norm) || [];
  g_commandQueue.set(norm, []);
  return list;
}

// Helper to ensure an ESP32 adapter exists
async function getOrCreateEsp32Adapter(trx = db) {
  let adapter = await trx('adapters').where({ vendor: 'esp32' }).first();
  if (!adapter) {
    const [id] = await trx('adapters').insert({
      name: 'ESP32 Smart Room Hubs',
      vendor: 'esp32',
      config: JSON.stringify({ timeoutMgits: 3000 }),
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
    { external_id: `light-${roomNumber}`, type: 'light', name: 'Suite Light', caps: { dimmable: false } },
    { external_id: `ac-${roomNumber}`, type: 'thermostat', name: 'Air Conditioner', caps: { modes: ['cool', 'heat', 'auto', 'fan'] } },
    { external_id: `tv-${roomNumber}`, type: 'tv', name: 'Smart TV', caps: {} },
    { external_id: `fridge-${roomNumber}`, type: 'other', name: 'Minibar Fridge', caps: {} },
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
        try { existingCaps = JSON.parse(existingCaps); } catch { }
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

export async function assignHubToRoom({ roomNumber, deviceId, ip = null }) {
  const cleanNum = String(roomNumber).replace(/Room\s*/i, '').trim();
  let room = await Room.findByNumber(cleanNum);
  if (!room && !isNaN(Number(cleanNum))) {
    room = await Room.findById(Number(cleanNum));
  }
  if (!room) {
    room = await Room.findByNumber(roomNumber);
  }
  if (!room) throw notFound(`Room ${roomNumber}`);
  const adapter = await getOrCreateEsp32Adapter();
  await ensureRoomDevices(room, adapter.id, ip);

  // Update capabilities & online status for ALL devices assigned to this room
  const allDevices = await db('devices').where({ room_id: room.id });
  for (const d of allDevices) {
    let caps = d.capabilities;
    if (typeof caps === 'string') {
      try { caps = JSON.parse(caps); } catch { }
    }
    caps = caps || {};
    if (deviceId) {
      caps.hubDeviceId = deviceId;
      if (ip) caps.ip = ip;
    } else {
      delete caps.hubDeviceId;
      delete caps.ip;
    }
    await db('devices').where({ id: d.id }).update({ capabilities: JSON.stringify(caps) });

    // Device states start OFFLINE until physical hardware actually transmits telemetry
    await db('device_states')
      .where({ device_id: d.id })
      .update({ online: false });
  }

  bus.publish(EVENTS.BOARD_CHANGED, { roomId: room.id, roomNumber: room.number });
  return { ok: true, roomNumber: room.number, deviceId, count: allDevices.length };
}

export async function processTelemetry({ roomNumber, deviceId, bme680, pzem, mq2, battery, relays, ip }) {
  const cleanNum = roomNumber ? String(roomNumber).replace(/Room\s*/i, '').trim() : null;
  let room = cleanNum ? await Room.findByNumber(cleanNum) : null;
  if (!room && cleanNum && !isNaN(Number(cleanNum))) {
    room = await Room.findById(Number(cleanNum));
  }
  if (!room && roomNumber) {
    room = await Room.findByNumber(roomNumber);
  }
  if (!room && deviceId) {
    const dev = await db('devices')
      .whereRaw(`JSON_UNQUOTE(JSON_EXTRACT(capabilities, '$.hubDeviceId')) = ?`, [deviceId])
      .orWhere('external_id', 'like', `%${deviceId}%`)
      .first('room_id');
    if (dev?.room_id) {
      room = await Room.findById(dev.room_id);
    }
  }
  if (!room) {
    throw notFound(`Room ${roomNumber || deviceId}`);
  }

  const adapter = await getOrCreateEsp32Adapter();
  const devices = await ensureRoomDevices(room, adapter.id, ip);
  const byExternal = new Map(devices.map((d) => [d.external_id, d]));

  const now = new Date();

  // 1. Update BME680 Sensor / Thermostat State
  if (bme680) {
    const bmeDev = byExternal.get(`sensor-bme680-${room.number}`) || byExternal.get(`sensor-bme680-${roomNumber}`);
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
    const meterDev = byExternal.get(`meter-pzem-${room.number}`) || byExternal.get(`meter-pzem-${roomNumber}`);
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
      { keys: ['light', 'light1'], exts: [`light-${room.number}`, `light-1-${room.number}`] },
      { keys: ['ac', 'light2'], exts: [`ac-${room.number}`, `light-2-${room.number}`] },
      { keys: ['tv', 'light3'], exts: [`tv-${room.number}`, `light-3-${room.number}`] },
      { keys: ['fridge', 'light4'], exts: [`fridge-${room.number}`, `light-4-${room.number}`] },
    ];

    for (const { keys, exts } of relayMap) {
      const val = keys.map((k) => relays[k]).find((v) => v !== undefined);
      if (isRelaySettling(String(room.number), keys[0])) continue; // dashboard command still in flight
      if (val !== undefined) {
        for (const ext of exts) {
          const dev = byExternal.get(ext);
          if (dev) {
            const state = dev.type === 'thermostat' ? { power: Boolean(val), on: Boolean(val) } : { on: Boolean(val) };
            await Device.updateState(dev.id, { online: true, state, last_seen_at: now });
            bus.publish(EVENTS.DEVICE_STATE, { deviceId: dev.id, roomId: room.id, online: true, state });
          }
        }
      }
    }
  }

  // 4. MQ-2 Safety & Smoke Alert Check
  if (mq2) {
    const mqDev = byExternal.get(`sensor-mq2-${room.number}`) || byExternal.get(`sensor-mq2-${roomNumber}`);
    if (mqDev) {
      const state = { smokeValue: mq2.smokeValue, smokeAlert: Boolean(mq2.smokeAlert) };
      await Device.updateState(mqDev.id, { online: true, state, last_seen_at: now });
    }

    if (mq2.smokeAlert || (mq2.smokeValue && mq2.smokeValue > 2000)) {
      await raiseAlert({
        type: 'device_fault',
        severity: 'critical',
        source: 'device',
        title: `Smoke / Combustible Gas Alarm in Room ${room.number || roomNumber}`,
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
  bus.publish(EVENTS.ROOM_CHANGED, { roomId: room.id }); // one-room push, no full-board reload

  const pendingCmds = popCommands(room.number);
  return { ok: true, roomNumber: room.number, commands: pendingCmds, processedAt: now };
}

export async function processEmergencyAlert({ roomNumber, type, value, message }) {
  const cleanNum = String(roomNumber).replace(/Room\s*/i, '').trim();
  let room = await Room.findByNumber(cleanNum);
  if (!room && !isNaN(Number(cleanNum))) room = await Room.findById(Number(cleanNum));
  if (!room) room = await Room.findByNumber(roomNumber);
  if (!room) throw notFound(`Room ${roomNumber}`);

  const adapter = await getOrCreateEsp32Adapter();

  const isSmoke = type === 'smoke_alert' || (type && type.includes('smoke'));
  const severity = isSmoke ? 'critical' : 'warning';
  const title = isSmoke
    ? `URGENT: Smoke / Gas Alarm in Room ${room.number}`
    : `Hardware Alert in Room ${room.number}: ${type}`;

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
  bus.publish(EVENTS.ROOM_CHANGED, { roomId: room.id }); // one-room push, no full-board reload
  return { ok: true, alertId, roomNumber: room.number };
}

export async function getRoomHardwareStatus(roomNumber) {
  const cleanNum = String(roomNumber).replace(/Room\s*/i, '').trim();
  let room = await Room.findByNumber(cleanNum);
  if (!room && !isNaN(Number(cleanNum))) room = await Room.findById(Number(cleanNum));
  if (!room) room = await Room.findByNumber(roomNumber);
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

export async function toggleActuator({ roomNumber, deviceKey, state }) {
  const cleanNum = String(roomNumber).replace(/Room\s*/i, '').trim();
  let room = await Room.findByNumber(cleanNum);
  if (!room && !isNaN(Number(cleanNum))) room = await Room.findById(Number(cleanNum));
  if (!room) room = await Room.findByNumber(roomNumber);
  if (!room) throw notFound(`Room ${roomNumber}`);

  // Enqueue command for instant cloud delivery to ESP32
  enqueueCommand(room.number, deviceKey, state);

  const adapter = await getOrCreateEsp32Adapter();
  const devices = await ensureRoomDevices(room, adapter.id);

  const keyLower = String(deviceKey).toLowerCase();
  // Prefer the exact relay device the hub reports on (e.g. `fridge-106`) over older duplicates.
  const exact = devices.find((d) => d.external_id === `${canonicalRelay(keyLower)}-${room.number}`);
  const target = exact || devices.find((d) => {
    const ext = (d.external_id || '').toLowerCase();
    const name = (d.name || '').toLowerCase();
    if (keyLower === 'light' || keyLower === 'light1') return ext.includes('light') && !ext.includes('light-2') && !ext.includes('light-3') && !ext.includes('light-4');
    if (keyLower === 'ac' || keyLower === 'light2') return ext.includes('ac') || d.type === 'thermostat';
    if (keyLower === 'tv' || keyLower === 'light3') return ext.includes('tv');
    if (keyLower === 'fridge' || keyLower === 'light4') return ext.includes('fridge');
    return ext.includes(keyLower) || name.includes(keyLower);
  });

  if (target) {
    const cmd = target.type === 'thermostat' ? { power: Boolean(state), on: Boolean(state) } : { on: Boolean(state) };
    try {
      const inst = adapterFor({ id: adapter.id, vendor: 'esp32', config: adapter.config });
      inst.sendCommand(target, cmd).catch(() => {});
    } catch {}

    await Device.updateState(target.id, { online: true, state: cmd, last_seen_at: new Date() });
    bus.publish(EVENTS.DEVICE_STATE, { deviceId: target.id, roomId: room.id, online: true, state: cmd });
  }

  bus.publish(EVENTS.ROOM_CHANGED, { roomId: room.id }); // one-room push, no full-board reload
  return { ok: true, queued: true, roomNumber: room.number, deviceKey, state };
}
