import { db } from '../config/db.js';

/** Table: energy_readings (kWh per room and meter per hour). */

const INTERVAL_FORMATS = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', month: '%Y-%m' };

function readings({ from, to, floor, roomId }) {
  const q = db('energy_readings as e')
    .join('rooms as r', 'r.id', 'e.room_id')
    .join('floors as f', 'f.id', 'r.floor_id')
    .where('e.period_start', '>=', from)
    .where('e.period_start', '<', to);
  if (floor?.length) q.whereIn('f.number', floor);
  if (roomId) q.where('e.room_id', roomId);
  return q;
}

/** kWh per room (or floor) per hour/day/month: rows of { key_id, label, floor?, period, kwh }. */
export function series(filters, groupBy, interval) {
  const keyCols = groupBy === 'floor' ? ['f.id as key_id', 'f.number as label'] : ['r.id as key_id', 'r.number as label', 'f.number as floor'];
  const groupCols = groupBy === 'floor' ? ['f.id', 'f.number'] : ['r.id', 'r.number', 'f.number'];
  return readings(filters)
    .select(keyCols)
    .select(db.raw('DATE_FORMAT(e.period_start, ?) AS period', [INTERVAL_FORMATS[interval]]))
    .sum({ kwh: 'e.kwh' })
    .groupBy([...groupCols, 'period'])
    .orderBy('period');
}

/** The 10 rooms that used the most energy. */
export function top10Rooms(filters) {
  return readings(filters).select('r.id as room_id', 'r.number', 'f.number as floor').sum({ kwh: 'e.kwh' }).groupBy('r.id', 'r.number', 'f.number').orderBy('kwh', 'desc').limit(10);
}

export async function totalKwh(filters) {
  const row = await readings(filters).sum({ kwh: 'e.kwh' }).first();
  return row?.kwh ?? 0;
}

/** Rows for the CSV export: { period, floor, room, kwh }. */
export function exportRows(filters, interval) {
  return readings(filters)
    .select('r.number as room', 'f.number as floor')
    .select(db.raw('DATE_FORMAT(e.period_start, ?) AS period', [INTERVAL_FORMATS[interval]]))
    .sum({ kwh: 'e.kwh' })
    .groupBy('r.number', 'f.number', 'period')
    .orderBy(['period', 'f.number', 'r.number']);
}

/** Inserts readings, replacing any existing value for the same room, device and hour. */
export function upsertMany(rows) {
  return db('energy_readings').insert(rows).onConflict(['room_id', 'device_id', 'period_start']).merge(['kwh', 'source']);
}

/** Start of the newest reading for these meters. */
export async function latestReadingAt(deviceIds) {
  const row = await db('energy_readings').whereIn('device_id', deviceIds).max({ at: 'period_start' }).first();
  return row?.at ?? null;
}
