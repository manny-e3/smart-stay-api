import { db, json, paginate } from '../config/db.js';

/** Tables: guests, guest_devices (phones registered for push), guest_preferences. */

/* ---- guests --------------------------------------------------------------------- */

export function findById(id, trx = db) {
  return trx('guests').where({ id }).first();
}

export function lockById(id, trx) {
  return trx('guests').where({ id }).forUpdate().first();
}

export function findByEmail(email) {
  return db('guests').whereRaw('LOWER(email) = ?', [String(email).trim().toLowerCase()]).first();
}

export function findByPmsId(connectionId, externalId, trx = db) {
  return trx('guests').where({ pms_connection_id: connectionId, external_id: externalId }).first('id');
}

export async function create(fields, trx = db) {
  const [id] = await trx('guests').insert(fields);
  return id;
}

export function update(id, fields, trx = db) {
  return trx('guests').where({ id }).update(fields);
}

/** Guest search: name, email, phone or booking reference. */
export function search({ q, vip, includeAnonymized, page, limit }) {
  const query = db('guests as g').select('g.*').orderBy('g.last_name').orderBy('g.first_name');
  if (!includeAnonymized) query.whereNull('g.anonymized_at');
  if (vip !== undefined) query.where('g.vip', vip);
  if (q) {
    query.where((w) =>
      w
        .whereILike('g.first_name', `%${q}%`)
        .orWhereILike('g.last_name', `%${q}%`)
        .orWhereILike('g.email', `%${q}%`)
        .orWhereILike('g.phone', `%${q}%`)
        .orWhereExists(db('stay_guests as sg').join('stays as s', 's.id', 'sg.stay_id').whereRaw('sg.guest_id = g.id').whereILike('s.reference', `%${q}%`)),
    );
  }
  return paginate(query, { page, limit });
}

/** A current or future booking the guest is on (blocks anonymising). */
export function findActiveBooking(guestId, trx = db) {
  return trx('stay_guests as sg').join('stays as s', 's.id', 'sg.stay_id').where('sg.guest_id', guestId).whereIn('s.status', ['reserved', 'checked_in']).first('s.reference');
}

/**
 * Guests to anonymise: no current or future stay, no stay that ended after the cutoff,
 * and created before the cutoff. At most 500 per run.
 */
export function listForRetention(cutoff) {
  return db('guests as g')
    .whereNull('g.anonymized_at')
    .whereNotExists(db('stay_guests as sg').join('stays as s', 's.id', 'sg.stay_id').whereRaw('sg.guest_id = g.id').whereIn('s.status', ['reserved', 'checked_in']))
    .whereNotExists(db('stay_guests as sg').join('stays as s', 's.id', 'sg.stay_id').whereRaw('sg.guest_id = g.id').whereRaw('COALESCE(s.checked_out_at, s.check_out_at) >= ?', [cutoff]))
    .where('g.created_at', '<', cutoff)
    .select('g.id')
    .limit(500);
}

/* ---- guest_devices --------------------------------------------------------------- */

/** Push tokens for a stay, or for a guest when no stay is given. */
export function pushTokens({ stayId, guestId }) {
  const q = db('guest_devices').select('id', 'push_token');
  if (stayId) q.where({ stay_id: stayId });
  else q.where({ guest_id: guestId });
  return q;
}

/** Registers a phone for push, or moves an existing token to this guest and stay. */
export function savePushToken({ guestId, stayId, pushToken, platform }) {
  return db('guest_devices').insert({ guest_id: guestId, stay_id: stayId, push_token: pushToken, platform }).onConflict('push_token').merge(['guest_id', 'stay_id', 'platform']);
}

export function deleteDevicesByIds(ids) {
  return db('guest_devices').whereIn('id', ids).del();
}

export function deleteDevicesForStay(stayId, trx = db) {
  return trx('guest_devices').where({ stay_id: stayId }).del();
}

export function deleteDevicesForGuest(guestId, trx = db) {
  return trx('guest_devices').where({ guest_id: guestId }).del();
}

/* ---- guest_preferences --------------------------------------------------------- */

export function findPreferences(guestId) {
  return db('guest_preferences').where({ guest_id: guestId }).first();
}

export function savePreferences(guestId, preferences) {
  return db('guest_preferences').insert({ guest_id: guestId, preferences: json(preferences) }).onConflict('guest_id').merge(['preferences']);
}

export function deletePreferences(guestId, trx = db) {
  return trx('guest_preferences').where({ guest_id: guestId }).del();
}
