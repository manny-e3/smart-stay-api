import { db } from '../config/db.js';

/**
 * Tables: guest_access_codes (booking codes and QR tokens, stored as keyed hashes)
 * and guest_sessions (signed-in guest app phones).
 */

/* ---- guest_access_codes ------------------------------------------------------------ */

export function revokeCodesForStay(stayId, trx = db) {
  return trx('guest_access_codes').where({ stay_id: stayId }).whereNull('revoked_at').update({ revoked_at: new Date() });
}

/** Saves a code. Throws ER_DUP_ENTRY when another live code has the same hash. */
export function insertCode({ stayId, kind, lookupHash, createdBy }, trx = db) {
  return trx('guest_access_codes').insert({ stay_id: stayId, kind, lookup_hash: lookupHash, created_by: createdBy });
}

/** The stay behind a live (not revoked) code or QR token. kind: 'code' | 'qr' */
export function findStayByLiveCode(kind, lookupHash) {
  return db('guest_access_codes as c').join('stays as s', 's.id', 'c.stay_id').where({ 'c.kind': kind, 'c.lookup_hash': lookupHash }).whereNull('c.revoked_at').first('s.*');
}

/* ---- guest_sessions -------------------------------------------------------------- */

export async function createSession(fields) {
  const [id] = await db('guest_sessions').insert(fields);
  return id;
}

export function findSession(id) {
  return db('guest_sessions').where({ id }).first();
}

export function updateSession(id, fields, trx = db) {
  return trx('guest_sessions').where({ id }).update(fields);
}

export function revokeSession(id) {
  return db('guest_sessions').where({ id }).update({ revoked_at: new Date() });
}

/** Phones signed in for a stay right now. */
export async function countLiveSessions(stayId) {
  const row = await db('guest_sessions').where({ stay_id: stayId }).whereNull('revoked_at').where('expires_at', '>', new Date()).count({ n: '*' }).first();
  return Number(row.n);
}

/** Signs out every phone of a guest (optionally only password sessions). */
export function revokeSessionsForGuest(guestId, { method } = {}, trx = db) {
  const q = trx('guest_sessions').where({ guest_id: guestId }).whereNull('revoked_at');
  if (method) q.where({ method });
  return q.update({ revoked_at: new Date() });
}

/** Signs out every phone on a stay, except sessions of exceptMethod when given. */
export function revokeSessionsForStay(stayId, { exceptMethod } = {}, trx = db) {
  const q = trx('guest_sessions').where({ stay_id: stayId }).whereNull('revoked_at');
  if (exceptMethod) q.whereNot('method', exceptMethod);
  return q.update({ revoked_at: new Date() });
}

/** Live password-account sessions pointing at a stay. */
export function listPasswordSessionsForStay(stayId, trx = db) {
  return trx('guest_sessions').where({ stay_id: stayId, method: 'password' }).whereNull('revoked_at');
}
