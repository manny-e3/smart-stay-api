import * as Guest from '../models/guest.model.js';
import * as Stay from '../models/stay.model.js';
import { badRequest } from '../utils/errors.js';
import { getSettings } from './settings.service.js';
import { capabilitiesFor, roomDevicesOfType, sendDeviceCommand } from './controls.service.js';

/**
 * Guest preferences (Release 2): lights, temperature and music. Stored per guest so they
 * carry over to the next stay, and applied to the room at check-in (setting
 * apply_guest_preferences_on_check_in) or when the guest asks.
 */

export async function getPreferences(guestId) {
  const row = await Guest.findPreferences(guestId);
  return { preferences: row?.preferences ?? {}, updatedAt: row?.updated_at ?? null };
}

export async function savePreferences(guestId, preferences) {
  const settings = await getSettings();
  const t = preferences.temperature?.setpoint;
  if (t !== undefined && (t < settings.ac_min_temp || t > settings.ac_max_temp)) {
    throw badRequest(`Temperature must be between ${settings.ac_min_temp} and ${settings.ac_max_temp}`, [{ field: 'body.preferences.temperature.setpoint', message: 'Outside the hotel AC range' }]);
  }
  await Guest.savePreferences(guestId, preferences);
  return getPreferences(guestId);
}

/**
 * Applies the stay's primary guest preferences to the room's devices.
 * Returns null when there is nothing to apply, else { applied, failed, skipped }.
 */
export async function applyGuestPreferences(stayId, { guestId } = {}) {
  const stay = await Stay.findCheckedIn(stayId);
  if (!stay?.room_id) return null;
  const { preferences: prefs } = await getPreferences(guestId ?? stay.guest_id);
  if (!prefs || !Object.keys(prefs).length) return null;

  const settings = await getSettings();
  const summary = { applied: 0, failed: 0, skipped: [] };
  const run = async (device, input) => {
    const res = await sendDeviceCommand(device, input, { source: 'preferences', guestId: guestId ?? stay.guest_id });
    if (res.ok) summary.applied++;
    else summary.failed++;
  };

  if (prefs.temperature) {
    const thermostats = await roomDevicesOfType(stay.room_id, ['thermostat']);
    if (!thermostats.length) summary.skipped.push('temperature: no AC in this room');
    for (const t of thermostats) {
      const caps = capabilitiesFor(t, settings);
      const setpoint = Math.min(settings.ac_max_temp, Math.max(settings.ac_min_temp, prefs.temperature.setpoint));
      await run(t, {
        setpoint: Math.round(setpoint / (caps.step || 0.5)) * (caps.step || 0.5),
        ...(prefs.temperature.mode && caps.modes.includes(prefs.temperature.mode) ? { mode: prefs.temperature.mode } : {}),
        ...(prefs.temperature.fan && caps.fanSpeeds.includes(prefs.temperature.fan) ? { fan: prefs.temperature.fan } : {}),
      });
    }
  }
  if (prefs.lights) {
    const lights = await roomDevicesOfType(stay.room_id, ['light']);
    if (!lights.length) summary.skipped.push('lights: no lights in this room');
    for (const l of lights) {
      const input = {};
      if (prefs.lights.on !== undefined) input.on = prefs.lights.on;
      if (prefs.lights.brightness !== undefined && capabilitiesFor(l, settings).dimmable) input.brightness = prefs.lights.brightness;
      if (Object.keys(input).length) await run(l, input);
    }
  }
  if (prefs.music) {
    const speakers = await roomDevicesOfType(stay.room_id, ['speaker']);
    if (!speakers.length) summary.skipped.push('music: no speaker in this room');
    for (const s of speakers) {
      const caps = capabilitiesFor(s, settings);
      const input = {};
      if (prefs.music.volume !== undefined) input.volume = Math.min(prefs.music.volume, caps.volumeMax);
      if (prefs.music.source && caps.sources.includes(prefs.music.source)) input.source = prefs.music.source;
      if (prefs.music.autoplay !== undefined) input.playing = prefs.music.autoplay;
      if (Object.keys(input).length) await run(s, input);
    }
  }

  await Stay.addEvent({ stayId, actorType: guestId ? 'guest' : 'system', action: 'preferences_applied', toRoomId: stay.room_id, data: summary });
  return summary;
}
