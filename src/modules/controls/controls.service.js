import { z } from 'zod';
import { db } from '../../config/db.js';
import { adapterFor } from '../../adapters/index.js';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import { raiseAlert } from '../alerts/alerts.service.js';
import { ingestEvent } from '../devices/devices.service.js';
import { getSettings } from '../settings/settings.service.js';

/**
 * Room controls for the guest app: lights, AC, curtains, TV and speaker.
 * Each device type has default capabilities, which the device mapping can override
 * (devices.capabilities). Commands are validated against the capabilities and the hotel
 * AC range before they reach the vendor adapter.
 */

export const GUEST_DEVICE_TYPES = ['light', 'thermostat', 'curtain', 'tv', 'speaker'];

const DEFAULT_CAPABILITIES = {
  light: { dimmable: false },
  thermostat: { modes: ['cool', 'heat', 'auto', 'fan'], fanSpeeds: ['auto', 'low', 'medium', 'high'], step: 0.5 },
  curtain: { positionable: true },
  tv: { volumeMax: 100, inputs: ['tv', 'hdmi1', 'hdmi2'], channels: true },
  speaker: { volumeMax: 100, sources: ['bluetooth', 'radio'] },
};

// State fields the guest app may see, per type. Internal fields (e.g. guestOverrideAt) are hidden.
const VISIBLE_STATE = {
  light: ['on', 'brightness'],
  thermostat: ['power', 'mode', 'setpoint', 'fan', 'temperature', 'humidity'],
  curtain: ['position', 'moving'],
  tv: ['power', 'volume', 'mute', 'channel', 'input'],
  speaker: ['power', 'volume', 'playing', 'source'],
};

export function capabilitiesFor(device, settings) {
  const caps = { ...DEFAULT_CAPABILITIES[device.type], ...(device.capabilities || {}) };
  if (device.type === 'thermostat') Object.assign(caps, { minTemp: settings.ac_min_temp, maxTemp: settings.ac_max_temp });
  return caps;
}

export function toGuestDevice(device, settings) {
  const state = device.state || {};
  const visible = Object.fromEntries(VISIBLE_STATE[device.type].filter((k) => state[k] !== undefined).map((k) => [k, state[k]]));
  return {
    id: device.id,
    type: device.type,
    name: device.name || device.type,
    online: device.online ?? true,
    state: visible,
    ...(device.type === 'thermostat' ? { eco: state.mode === 'eco' } : {}),
    capabilities: capabilitiesFor(device, settings),
    lastSeenAt: device.last_seen_at ?? null,
  };
}

const deviceQuery = () =>
  db('devices as d')
    .join('adapters as a', 'a.id', 'd.adapter_id')
    .leftJoin('device_states as s', 's.device_id', 'd.id')
    .where({ 'd.is_active': true, 'a.is_enabled': true })
    // "config", "state" and "capabilities" keep their names so the JSON columns are parsed.
    .select('d.*', 's.state', 's.online', 's.last_seen_at', 'a.id as a_id', 'a.name as a_name', 'a.vendor as a_vendor', 'a.config', 'a.updated_at as a_updated_at');

const adapterOf = (d) => adapterFor({ id: d.a_id, name: d.a_name, vendor: d.a_vendor, config: d.config, updated_at: d.a_updated_at });

export async function listRoomDevices(roomId) {
  const settings = await getSettings();
  const devices = await deviceQuery().where('d.room_id', roomId).whereIn('d.type', GUEST_DEVICE_TYPES).orderByRaw("FIELD(d.type, 'light', 'thermostat', 'curtain', 'tv', 'speaker')").orderBy('d.name');
  return devices.map((d) => toGuestDevice(d, settings));
}

/** Eco state of a room: on when a thermostat in it is in eco mode. */
export async function roomEcoState(roomId) {
  const thermostats = await deviceQuery().where({ 'd.room_id': roomId, 'd.type': 'thermostat' });
  const eco = thermostats.filter((t) => t.state?.mode === 'eco');
  if (!eco.length) return { active: false, since: null, setpoint: null };
  return { active: true, since: eco[0].state.ecoSince ?? eco[0].last_seen_at ?? null, setpoint: eco[0].state.setpoint ?? null };
}

/* -------------------------------------------------------------- commands */

const atLeastOne = (s) => s.refine((v) => Object.keys(v).length > 0, { message: 'Send at least one setting to change' });

function commandSchema(device, caps) {
  switch (device.type) {
    case 'light':
      return atLeastOne(
        z
          .object({ on: z.boolean().optional(), brightness: z.number().int().min(0).max(100).optional() })
          .strict()
          .refine((v) => v.brightness === undefined || caps.dimmable, { message: 'This light cannot be dimmed', path: ['brightness'] }),
      );
    case 'thermostat':
      return atLeastOne(
        z
          .object({
            power: z.boolean().optional(),
            setpoint: z
              .number()
              .min(caps.minTemp, `Temperature must be between ${caps.minTemp} and ${caps.maxTemp}`)
              .max(caps.maxTemp, `Temperature must be between ${caps.minTemp} and ${caps.maxTemp}`)
              .refine((v) => Number.isInteger(v / (caps.step || 0.5)), `Use steps of ${caps.step || 0.5}`)
              .optional(),
            mode: z.enum(caps.modes).optional(),
            fan: z.enum(caps.fanSpeeds).optional(),
          })
          .strict(),
      );
    case 'curtain':
      return z
        .object({ action: z.enum(['open', 'close', 'stop']).optional(), position: z.number().int().min(0).max(100).optional() })
        .strict()
        .refine((v) => (v.action === undefined) !== (v.position === undefined), { message: 'Send either action or position' })
        .refine((v) => v.position === undefined || caps.positionable, { message: 'This curtain only opens and closes', path: ['position'] });
    case 'tv':
      return atLeastOne(
        z
          .object({
            power: z.boolean().optional(),
            volume: z.number().int().min(0).max(caps.volumeMax).optional(),
            mute: z.boolean().optional(),
            channel: z.number().int().min(1).max(9999).optional(),
            input: z.enum(caps.inputs).optional(),
          })
          .strict()
          .refine((v) => v.channel === undefined || caps.channels, { message: 'This TV does not support channels', path: ['channel'] }),
      );
    case 'speaker':
      return atLeastOne(
        z
          .object({
            power: z.boolean().optional(),
            volume: z.number().int().min(0).max(caps.volumeMax).optional(),
            playing: z.boolean().optional(),
            source: z.enum(caps.sources).optional(),
          })
          .strict(),
      );
    default:
      throw badRequest('This device cannot be controlled from the app');
  }
}

/** Turns a validated guest command into the adapter command and the expected new state. */
function toAdapterCommand(device, input) {
  const state = device.state || {};
  switch (device.type) {
    case 'light': {
      const next = { ...input };
      if (input.brightness !== undefined && input.on === undefined) next.on = input.brightness > 0;
      return { command: { action: 'set_light', ...next }, state: next };
    }
    case 'thermostat': {
      const next = { ...input };
      // Any guest change ends eco: go back to the mode the room had before eco.
      if (state.mode === 'eco' && !input.mode && input.power !== false) next.mode = state.modeBeforeEco && state.modeBeforeEco !== 'eco' ? state.modeBeforeEco : 'cool';
      if (input.power === false) next.mode = next.mode ?? state.mode;
      return { command: { action: 'set_climate', ...next }, state: { ...next, guestOverrideAt: new Date().toISOString() } };
    }
    case 'curtain': {
      const position = input.position ?? (input.action === 'open' ? 100 : input.action === 'close' ? 0 : state.position);
      return { command: { action: 'set_curtain', ...input }, state: { ...(position !== undefined ? { position } : {}), moving: false } };
    }
    case 'tv':
      return { command: { action: 'set_tv', ...input }, state: { ...input } };
    case 'speaker':
      return { command: { action: 'set_speaker', ...input }, state: { ...input } };
    default:
      throw badRequest('This device cannot be controlled from the app');
  }
}

/**
 * Sends a command to a device. Used by the guest app and by saved preferences.
 * Returns { ok, device, latencyMs, error }.
 */
export async function sendDeviceCommand(device, input, { source = 'guest', guestId = null } = {}) {
  const { command, state } = toAdapterCommand(device, input);
  const started = Date.now();
  let result;
  try {
    result = await adapterOf(device).sendCommand(device, command);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  const latencyMs = Date.now() - started;
  if (!result.ok) {
    await raiseAlert({
      type: 'command_failed',
      severity: 'warning',
      source: 'system',
      title: `${device.name || device.type} did not respond to a ${source} command`,
      message: result.error ?? null,
      roomId: device.room_id,
      deviceId: device.id,
      payload: { command, guestId },
    });
    return { ok: false, latencyMs, error: result.error };
  }
  // Keep only fields the adapter reported, plus what we asked for.
  const newState = { ...state, ...(result.state ? Object.fromEntries(Object.entries(result.state).filter(([k]) => k !== 'lastAction' && k !== 'action')) : {}) };
  await ingestEvent(device, { type: 'status', payload: { online: true, state: newState } });
  const fresh = await deviceQuery().where('d.id', device.id).first();
  return { ok: true, latencyMs, device: toGuestDevice(fresh, await getSettings()) };
}

/** Guest app: command a device in the guest's current room. */
export async function guestCommand({ roomId, guestId }, deviceId, body) {
  const settings = await getSettings();
  const device = await deviceQuery().where({ 'd.id': deviceId, 'd.room_id': roomId }).whereIn('d.type', GUEST_DEVICE_TYPES).first();
  if (!device) throw notFound('Device');
  if (device.online === false) throw new AppError(409, `${device.name || 'This device'} is offline. Please contact the front desk.`, 'DEVICE_OFFLINE');

  const parsed = commandSchema(device, capabilitiesFor(device, settings)).safeParse(body ?? {});
  if (!parsed.success) {
    throw badRequest('Validation failed', parsed.error.issues.map((i) => ({ field: ['body', ...i.path].join('.'), message: i.message })));
  }
  const res = await sendDeviceCommand(device, parsed.data, { source: 'guest', guestId });
  if (!res.ok) throw new AppError(502, `${device.name || 'The device'} did not respond. Please try again.`, 'COMMAND_FAILED');
  return { device: res.device, latencyMs: res.latencyMs };
}

/** Devices in a room by type, for applying preferences. */
export const roomDevicesOfType = (roomId, types) => deviceQuery().where('d.room_id', roomId).whereIn('d.type', types);
