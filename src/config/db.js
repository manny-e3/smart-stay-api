import knexLib from 'knex';
import config from '../../knexfile.js';

/**
 * The database connection (Knex query builder). Only files in src/models should run queries;
 * services group several model calls into one transaction with `transaction()`.
 */
export const db = knexLib(config);

export async function testConnection() {
  await db.raw('SELECT 1');
}

/**
 * Runs fn inside a database transaction. Pass the `trx` it receives to every model call
 * so they all commit together, or all roll back if anything throws.
 *
 *   await transaction(async (trx) => {
 *     await stayModel.update(id, { status: 'checked_out' }, trx);
 *     await roomModel.update(roomId, { dnd: false }, trx);
 *   });
 */
export const transaction = (fn) => db.transaction(fn);

/** Paginates a knex query builder. Returns { items, page, limit, total }. */
export async function paginate(query, { page = 1, limit = 25 } = {}) {
  const row = await query.clone().clearSelect().clearOrder().count({ total: '*' }).first();
  const items = await query.limit(limit).offset((page - 1) * limit);
  return { items, page, limit, total: Number(row?.total ?? 0) };
}

/** Value for a JSON column: objects are stored as text, null stays null. */
export const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
