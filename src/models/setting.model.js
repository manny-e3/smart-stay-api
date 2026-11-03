import { db, json } from '../config/db.js';

/** Table: settings (one row per setting: key, JSON value). */

export function findAll() {
  return db('settings').select('key', 'value');
}

/** Inserts or replaces one setting. */
export function upsert(key, value, updatedBy, trx = db) {
  return trx('settings').insert({ key, value: json(value), updated_by: updatedBy ?? null }).onConflict('key').merge();
}

/** Inserts a setting only if it doesn't exist yet (used by seeds). */
export function insertIfMissing(key, value, trx = db) {
  return trx('settings').insert({ key, value: json(value) }).onConflict('key').ignore();
}
