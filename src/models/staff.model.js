import { db, paginate, json } from '../config/db.js';

/** Tables: staff, sessions (staff logins), push_subscriptions (browser notifications). */

/* ---- staff ----------------------------------------------------------------- */

export function findById(id, trx = db) {
  return trx('staff').where({ id }).first();
}

export function findByEmail(email, trx = db) {
  return trx('staff').whereRaw('LOWER(email) = ?', [email.toLowerCase()]).first();
}

/** Another account already using this email (case-insensitive), ignoring excludeId. */
export function findByEmailExcept(email, excludeId, trx = db) {
  return trx('staff').whereRaw('LOWER(email) = ?', [email.toLowerCase()]).whereNot({ id: excludeId }).first('id');
}

export function list({ role, active, q, page, limit }) {
  const query = db('staff').select('*').orderBy('name');
  if (role) query.where({ role });
  if (active !== undefined) query.where({ is_active: active });
  if (q) query.where((w) => w.whereILike('name', `%${q}%`).orWhereILike('email', `%${q}%`));
  return paginate(query, { page, limit });
}

/** Active staff in the given roles, with their number of open requests. */
export function listActiveInRoles(roles, openStatuses) {
  return db('staff as s')
    .leftJoin('requests as q', (j) => j.on('q.assigned_to', 's.id').onIn('q.status', openStatuses))
    .where('s.is_active', true)
    .whereIn('s.role', roles)
    .groupBy('s.id', 's.name', 's.role')
    .orderBy('s.name')
    .select('s.id', 's.name', 's.role')
    .count({ open: 'q.id' });
}

export function findActiveInRoles(id, trx = db) {
  return trx('staff').where({ id, is_active: true }).first('id', 'name', 'role');
}

export async function create(fields, trx = db) {
  const [id] = await trx('staff').insert(fields);
  return id;
}

export function update(id, fields, trx = db) {
  return trx('staff').where({ id }).update(fields);
}

/** Locks all admin rows until the transaction ends, so two admins can't remove each other at once. */
export function lockAdmins(trx) {
  return trx('staff').where({ role: 'admin' }).forUpdate().select('id');
}

export async function countActiveAdminsExcept(excludeId, trx = db) {
  const row = await trx('staff').where({ role: 'admin', is_active: true }).whereNot({ id: excludeId }).count({ n: '*' }).first();
  return Number(row.n);
}

/** The first active admin, used as the author of script actions. */
export function findFirstActiveAdmin() {
  return db('staff').where({ role: 'admin', is_active: true }).orderBy('id').first('id');
}

/* ---- sessions -------------------------------------------------------------- */

export async function createSession(fields, trx = db) {
  const [id] = await trx('sessions').insert(fields);
  return id;
}

/** A live session with its active staff member, for checking access tokens. */
export function findLiveSession(sessionId, staffId) {
  return db('sessions as s')
    .join('staff as st', 'st.id', 's.staff_id')
    .where({ 's.id': sessionId, 's.staff_id': staffId, 'st.is_active': true })
    .whereNull('s.revoked_at')
    .where('s.expires_at', '>', db.fn.now(3))
    .first('st.id', 'st.name', 'st.email', 'st.role', 's.id as session_id');
}

/** Session found by its refresh token hash, joined with the staff row. */
export function findSessionByRefreshHash(hash) {
  return db('sessions as s')
    .join('staff as st', 'st.id', 's.staff_id')
    .where('s.refresh_token_hash', hash)
    .first('s.id as session_id', 's.revoked_at', 's.expires_at', 'st.*');
}

export function revokeSession(sessionId, trx = db) {
  return trx('sessions').where({ id: sessionId }).update({ revoked_at: new Date() });
}

/** Revokes an unrevoked session by id or by refresh token hash. */
export function revokeOpenSession({ sessionId, refreshTokenHash }, trx = db) {
  const q = trx('sessions').whereNull('revoked_at');
  if (sessionId) q.where({ id: sessionId });
  else q.where({ refresh_token_hash: refreshTokenHash });
  return q.update({ revoked_at: new Date() });
}

export function revokeAllSessions(staffId, trx = db) {
  return trx('sessions').where({ staff_id: staffId }).whereNull('revoked_at').update({ revoked_at: new Date() });
}

export function revokeOtherSessions(staffId, keepSessionId, trx = db) {
  return trx('sessions').where({ staff_id: staffId }).whereNot({ id: keepSessionId }).whereNull('revoked_at').update({ revoked_at: new Date() });
}

/* ---- push_subscriptions ----------------------------------------------------- */

export function savePushSubscription({ staffId, endpoint, endpointHash, keys }) {
  return db('push_subscriptions')
    .insert({ staff_id: staffId, endpoint, endpoint_hash: endpointHash, keys: json(keys) })
    .onConflict('endpoint_hash')
    .merge(['staff_id', 'keys']);
}

export function deletePushSubscription(staffId, endpointHash) {
  return db('push_subscriptions').where({ staff_id: staffId, endpoint_hash: endpointHash }).del();
}

/** Browser push subscriptions of active staff in the given roles. */
export function pushSubscriptionsForRoles(roles) {
  return db('push_subscriptions as p')
    .join('staff as s', 's.id', 'p.staff_id')
    .whereIn('s.role', roles)
    .where('s.is_active', true)
    .select('p.id', 'p.endpoint', 'p.keys');
}

export function deletePushSubscriptionById(id) {
  return db('push_subscriptions').where({ id }).del();
}
