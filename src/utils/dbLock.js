import { db } from '../config/db.js';

/**
 * Runs fn only if this process gets the named MySQL lock, so a job
 * runs on one server at a time even when several API instances are up.
 * Returns { ran: boolean, result }.
 *
 * GET_LOCK belongs to the connection's session. If the database drops that connection while fn
 * runs (cloud hosts reset idle sockets), MySQL frees the lock itself, so a failed RELEASE_LOCK is
 * logged instead of failing the job. Knex validates connections on acquire and discards dead ones.
 */
export async function withDbLock(name, fn) {
  const lockName = `smartstay:${name}`;
  const conn = await db.client.acquireConnection();
  try {
    const [rows] = await db.raw('SELECT GET_LOCK(?, 0) AS got', [lockName]).connection(conn);
    if (Number(rows[0]?.got) !== 1) return { ran: false };
    try {
      return { ran: true, result: await fn() };
    } finally {
      try {
        await db.raw('SELECT RELEASE_LOCK(?)', [lockName]).connection(conn);
      } catch (err) {
        console.warn(`[dbLock] Could not release ${lockName} (${err.code || err.message}); MySQL frees it when the connection closes.`);
      }
    }
  } finally {
    await db.client.releaseConnection(conn);
  }
}
