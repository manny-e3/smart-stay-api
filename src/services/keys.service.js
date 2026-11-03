import * as DigitalKey from '../models/digitalKey.model.js';
import * as Device from '../models/device.model.js';
import * as Stay from '../models/stay.model.js';
import * as Room from '../models/room.model.js';
import { adapterFor } from '../integrations/devices/index.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { badRequest, forbidden, AppError } from '../utils/errors.js';
import { raiseAlert } from './alerts.service.js';
import { ingestEvent } from './devices.service.js';
import { getSettings } from './settings.service.js';

/**
 * Digital keys: guests unlock their door with the app. A key is issued on every lock in the
 * room at check-in, moved on a room change, extended with the stay and revoked at check-out.
 * Failures raise critical alerts: a guest without a key can't get in, and a key that can't be
 * revoked means a former guest may still open the door.
 */

const lockQuery = () => Device.locksWithAdapter();

const adapterOf = (d) => adapterFor({ id: d.a_id, name: d.a_name, vendor: d.a_vendor, config: d.config, updated_at: d.a_updated_at });

async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export const toKey = (k) => ({
  id: k.id,
  deviceId: k.device_id,
  roomId: k.room_id,
  status: k.status,
  validFrom: k.valid_from,
  validUntil: k.valid_until,
  lastError: k.last_error,
  issuedAt: k.issued_at,
  revokedAt: k.revoked_at,
});

async function keyEnd(stay) {
  const { checkout_grace_minutes: grace } = await getSettings();
  return new Date(new Date(stay.check_out_at).getTime() + grace * 60_000);
}

/** Issues keys on every lock in the stay's current room. Returns the key rows. */
export async function issueKeysForStay(stayId) {
  const stay = await Stay.findWithGuestAndRoom(stayId);
  if (!stay?.room_id || stay.status !== 'checked_in') return [];
  const locks = await lockQuery().where('d.room_id', stay.room_id);
  const validFrom = new Date();
  const validUntil = await keyEnd(stay);
  const guestName = [stay.first_name, stay.last_name].filter(Boolean).join(' ');

  const keys = [];
  for (const lock of locks) {
    const res = await safe(() => adapterOf(lock).issueKey(lock, { stayId, guestName, validFrom, validUntil }));
    const id = await DigitalKey.create({
      stay_id: stayId,
      device_id: lock.id,
      room_id: stay.room_id,
      external_key_id: res.ok ? res.externalKeyId : null,
      credential_encrypted: res.ok && res.credential ? encrypt(res.credential) : null,
      status: res.ok ? 'active' : 'failed',
      valid_from: validFrom,
      valid_until: validUntil,
      last_error: res.ok ? null : String(res.error || 'Unknown error').slice(0, 500),
    });
    if (!res.ok) {
      await raiseAlert({
        type: 'key_failed',
        severity: 'critical',
        source: 'system',
        title: `Digital key could not be issued for room ${stay.room_number}`,
        message: `${res.error}. Give the guest a physical key card or retry from the stay screen.`,
        roomId: stay.room_id,
        deviceId: lock.id,
        payload: { stayId },
      });
    }
    keys.push(await DigitalKey.findById(id));
  }
  return keys.map(toKey);
}

/** Revokes active keys for a stay (optionally only for one room). Failed revocations are retried by a job. */
export async function revokeKeysForStay(stayId, { roomId } = {}) {
  const keys = await DigitalKey.listRevocable(stayId, roomId);
  const results = [];
  for (const key of keys) results.push(await revokeKey(key));
  return results;
}

async function revokeKey(key) {
  const lock = await lockQuery().where('d.id', key.device_id).first();
  const res = !key.external_key_id ? { ok: true } : lock ? await safe(() => adapterOf(lock).revokeKey(lock, key.external_key_id)) : { ok: false, error: 'Lock or its adapter is no longer active' };
  if (res.ok) {
    await DigitalKey.update(key.id, { status: 'revoked', revoked_at: new Date(), last_error: null });
  } else {
    await DigitalKey.update(key.id, { status: 'revoke_failed', last_error: String(res.error).slice(0, 500) });
    const room = await Room.findNumber(key.room_id);
    await raiseAlert({
      type: 'key_revoke_failed',
      severity: 'critical',
      source: 'system',
      title: `Former guest key could not be revoked in room ${room?.number ?? key.room_id}`,
      message: `${res.error}. Disable the key on the lock manually; the system keeps retrying.`,
      roomId: key.room_id,
      deviceId: key.device_id,
      payload: { stayId: key.stay_id, keyId: key.id },
    });
  }
  return { keyId: key.id, ok: res.ok, error: res.ok ? undefined : res.error };
}

/** Moves the end time of active keys after an extension. Falls back to re-issuing. */
export async function extendKeysForStay(stayId) {
  const stay = await Stay.findById(stayId);
  const validUntil = await keyEnd(stay);
  const keys = await DigitalKey.listActiveForStay(stayId);
  let reissue = false;
  for (const key of keys) {
    const lock = await lockQuery().where('d.id', key.device_id).first();
    const res = lock ? await safe(() => adapterOf(lock).updateKey(lock, key.external_key_id, { validUntil })) : { ok: false };
    if (res.ok) await DigitalKey.update(key.id, { valid_until: validUntil });
    else reissue = true;
  }
  if (reissue) {
    await revokeKeysForStay(stayId);
    return issueKeysForStay(stayId);
  }
  return (await DigitalKey.listActiveForStay(stayId)).map(toKey);
}

/** Active keys for the stay's current room that are inside their validity window right now. */
const usableKeys = (stayId, roomId) => DigitalKey.listUsable(stayId, roomId);

/** Short key status for the home screen. */
export async function keySummary(stayId, roomId) {
  const keys = await usableKeys(stayId, roomId);
  if (!keys.length) return { available: false, validUntil: null };
  return { available: true, validUntil: keys.reduce((m, k) => (k.valid_until > m ? k.valid_until : m), keys[0].valid_until) };
}

/**
 * Key credentials for the guest app, only inside the stay window.
 * methods.ble: the app can unlock with the vendor SDK (needs a credential).
 * methods.remote: the app can call POST /guest/key/unlock (the web app's only option).
 */
export async function guestKeys(stayId, roomId) {
  const keys = await usableKeys(stayId, roomId);
  if (!keys.length) throw new AppError(403, 'Your digital key is not active right now. Please contact the front desk.', 'KEY_NOT_ACTIVE');
  const items = keys.map((k) => ({
    ...toKey(k),
    doorName: k.door_name || 'Room door',
    credential: decrypt(k.credential_encrypted),
    remoteUnlock: adapterOf({ ...k }).supportsRemoteUnlock(),
  }));
  return {
    methods: { ble: items.some((k) => k.credential), remote: items.some((k) => k.remoteUnlock) },
    validFrom: items[0].validFrom,
    validUntil: items[0].validUntil,
    keys: items,
  };
}

/** Opens a door in the guest's current room with their key, and logs the unlock. */
export async function remoteUnlock({ stayId, guestId, roomId }, deviceId) {
  const key = await DigitalKey.findActiveForDoor(stayId, roomId, deviceId);
  if (!key) throw forbidden('You have no active key for this door');
  const now = new Date();
  if (new Date(key.valid_until) < now || new Date(key.valid_from) > now) throw new AppError(403, 'Your digital key is not active right now', 'KEY_NOT_ACTIVE');

  const lock = await lockQuery().where('d.id', key.device_id).first();
  if (!lock) throw badRequest('This door is not available');
  const res = await safe(() => adapterOf(lock).unlock(lock, { externalKeyId: key.external_key_id }));
  await ingestEvent(lock, { type: 'unlock', payload: { guestId, method: 'mobile_app', success: res.ok, ...(res.ok ? {} : { error: res.error }) } });
  if (!res.ok) throw new AppError(502, 'The door could not be opened. Please try again or contact the front desk.', 'UNLOCK_FAILED');
  return { deviceId: lock.id, unlockedAt: new Date().toISOString() };
}

/** Background retry for keys that could not be revoked. */
export async function retryFailedRevocations() {
  const keys = await DigitalKey.listRevokeFailed();
  let fixed = 0;
  for (const key of keys) if ((await revokeKey(key)).ok) fixed++;
  return fixed;
}
