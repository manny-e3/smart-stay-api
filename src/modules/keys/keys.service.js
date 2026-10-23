import { db } from '../../config/db.js';
import { adapterFor } from '../../adapters/index.js';
import { encrypt, decrypt } from '../../core/crypto.js';
import { badRequest, forbidden, AppError } from '../../core/errors.js';
import { raiseAlert } from '../alerts/alerts.service.js';
import { ingestEvent } from '../devices/devices.service.js';
import { getSettings } from '../settings/settings.service.js';

/**
 * Digital keys: guests unlock their door with the app. A key is issued on every lock in the
 * room at check-in, moved on a room change, extended with the stay and revoked at check-out.
 * Failures raise critical alerts: a guest without a key can't get in, and a key that can't be
 * revoked means a former guest may still open the door.
 */

const lockQuery = () =>
  db('devices as d')
    .join('adapters as a', 'a.id', 'd.adapter_id')
    .where({ 'd.type': 'lock', 'd.is_active': true, 'a.is_enabled': true })
    // "config" keeps its name so the JSON column is parsed (devices have no config column).
    .select('d.*', 'a.id as a_id', 'a.name as a_name', 'a.vendor as a_vendor', 'a.config', 'a.updated_at as a_updated_at');

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
  const stay = await db('stays as s').join('guests as g', 'g.id', 's.guest_id').leftJoin('rooms as r', 'r.id', 's.room_id').where('s.id', stayId).first('s.*', 'g.first_name', 'g.last_name', 'r.number as room_number');
  if (!stay?.room_id || stay.status !== 'checked_in') return [];
  const locks = await lockQuery().where('d.room_id', stay.room_id);
  const validFrom = new Date();
  const validUntil = await keyEnd(stay);
  const guestName = [stay.first_name, stay.last_name].filter(Boolean).join(' ');

  const keys = [];
  for (const lock of locks) {
    const res = await safe(() => adapterOf(lock).issueKey(lock, { stayId, guestName, validFrom, validUntil }));
    const [id] = await db('digital_keys').insert({
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
    keys.push(await db('digital_keys').where({ id }).first());
  }
  return keys.map(toKey);
}

/** Revokes active keys for a stay (optionally only for one room). Failed revocations are retried by a job. */
export async function revokeKeysForStay(stayId, { roomId } = {}) {
  const q = db('digital_keys').where({ stay_id: stayId }).whereIn('status', ['active', 'revoke_failed']);
  if (roomId) q.where({ room_id: roomId });
  const keys = await q;
  const results = [];
  for (const key of keys) results.push(await revokeKey(key));
  return results;
}

async function revokeKey(key) {
  const lock = await lockQuery().where('d.id', key.device_id).first();
  const res = !key.external_key_id ? { ok: true } : lock ? await safe(() => adapterOf(lock).revokeKey(lock, key.external_key_id)) : { ok: false, error: 'Lock or its adapter is no longer active' };
  if (res.ok) {
    await db('digital_keys').where({ id: key.id }).update({ status: 'revoked', revoked_at: new Date(), last_error: null });
  } else {
    await db('digital_keys').where({ id: key.id }).update({ status: 'revoke_failed', last_error: String(res.error).slice(0, 500) });
    const room = await db('rooms').where({ id: key.room_id }).first('number');
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
  const stay = await db('stays').where({ id: stayId }).first();
  const validUntil = await keyEnd(stay);
  const keys = await db('digital_keys').where({ stay_id: stayId, status: 'active' });
  let reissue = false;
  for (const key of keys) {
    const lock = await lockQuery().where('d.id', key.device_id).first();
    const res = lock ? await safe(() => adapterOf(lock).updateKey(lock, key.external_key_id, { validUntil })) : { ok: false };
    if (res.ok) await db('digital_keys').where({ id: key.id }).update({ valid_until: validUntil });
    else reissue = true;
  }
  if (reissue) {
    await revokeKeysForStay(stayId);
    return issueKeysForStay(stayId);
  }
  return (await db('digital_keys').where({ stay_id: stayId, status: 'active' })).map(toKey);
}

/** Active keys for the stay's current room that are inside their validity window right now. */
async function usableKeys(stayId, roomId) {
  const now = new Date();
  return db('digital_keys as k')
    .join('devices as d', 'd.id', 'k.device_id')
    .join('adapters as a', 'a.id', 'd.adapter_id')
    .where({ 'k.stay_id': stayId, 'k.room_id': roomId, 'k.status': 'active' })
    .where('k.valid_from', '<=', now)
    .where('k.valid_until', '>', now)
    .select('k.*', 'd.name as door_name', 'd.external_id', 'd.type', 'a.id as a_id', 'a.name as a_name', 'a.vendor as a_vendor', 'a.config', 'a.updated_at as a_updated_at');
}

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
  const q = db('digital_keys').where({ stay_id: stayId, room_id: roomId, status: 'active' });
  if (deviceId) q.where({ device_id: deviceId });
  const key = await q.orderBy('id', 'desc').first();
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
  const keys = await db('digital_keys').where({ status: 'revoke_failed' });
  let fixed = 0;
  for (const key of keys) if ((await revokeKey(key)).ok) fixed++;
  return fixed;
}
