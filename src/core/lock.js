import { db } from '../config/db.js';

/**
 * Runs fn only if this process gets the named MySQL lock, so a job
 * runs on one server at a time even when several API instances are up.
 * Returns { ran: boolean, result }.
 */
export async function withDbLock(name, fn) {
  const conn = await db.client.acquireConnection();
  try {
    const [rows] = await db.raw('SELECT GET_LOCK(?, 0) AS got', [`smartstay:${name}`]).connection(conn);
    if (Number(rows[0]?.got) !== 1) return { ran: false };
    try {
      return { ran: true, result: await fn() };
    } finally {
      await db.raw('SELECT RELEASE_LOCK(?)', [`smartstay:${name}`]).connection(conn);
    }
  } finally {
    await db.client.releaseConnection(conn);
  }
}
