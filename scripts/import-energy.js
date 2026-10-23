/**
 * Imports energy readings from a CSV export (for meters without an API).
 *
 *   node scripts/import-energy.js readings.csv
 *
 * Columns: room, period_start (ISO date-time, hour bucket), kwh, external_id (optional meter id)
 */
import { readCsv, run } from './_util.js';
import { db } from '../src/config/db.js';
import { saveReadings } from '../src/modules/energy/energy.service.js';

run(async () => {
  const rows = readCsv(process.argv[2]);
  const rooms = new Map((await db('rooms').select('id', 'number')).map((r) => [r.number, r.id]));
  const meters = new Map((await db('devices').where({ type: 'meter' }).select('id', 'external_id')).map((d) => [d.external_id, d.id]));
  const readings = [];
  for (const [i, r] of rows.entries()) {
    const roomId = rooms.get(r.room);
    const at = new Date(r.period_start);
    const kwh = Number(r.kwh);
    if (!roomId || Number.isNaN(at.getTime()) || !Number.isFinite(kwh)) {
      console.warn(`Line ${i + 2}: skipped (unknown room, bad date or bad kwh)`);
      continue;
    }
    at.setUTCMinutes(0, 0, 0);
    readings.push({ roomId, deviceId: r.external_id ? meters.get(r.external_id) ?? null : null, periodStart: at, kwh });
  }
  console.log(`${await saveReadings(readings, 'csv')} reading(s) imported`);
});
