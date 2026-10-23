import knexLib from 'knex';
import config from '../../knexfile.js';

export const db = knexLib(config);

export async function testConnection() {
  await db.raw('SELECT 1');
}

/** Paginates a knex query builder. Returns { items, page, limit, total }. */
export async function paginate(query, { page = 1, limit = 25 } = {}) {
  const row = await query.clone().clearSelect().clearOrder().count({ total: '*' }).first();
  const items = await query.limit(limit).offset((page - 1) * limit);
  return { items, page, limit, total: Number(row?.total ?? 0) };
}

export const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
