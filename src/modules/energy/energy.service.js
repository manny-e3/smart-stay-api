import { stringify } from 'csv-stringify';
import { db } from '../../config/db.js';
import { adapterFor } from '../../adapters/index.js';

const INTERVAL_FORMATS = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', month: '%Y-%m' };
const DEFAULT_DAYS = 7;

export function resolveRange({ from, to }) {
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - DEFAULT_DAYS * 86_400_000);
  return { from: start, to: end };
}

function readingsQuery({ from, to, floor, roomId }) {
  const q = db('energy_readings as e')
    .join('rooms as r', 'r.id', 'e.room_id')
    .join('floors as f', 'f.id', 'r.floor_id')
    .where('e.period_start', '>=', from)
    .where('e.period_start', '<', to);
  if (floor?.length) q.whereIn('f.number', floor);
  if (roomId) q.where('e.room_id', roomId);
  return q;
}

const round = (n) => Math.round(Number(n) * 1000) / 1000;

/** Energy use grouped by room or floor over hour/day/month buckets, plus the top 10 rooms. */
export async function getEnergy({ from, to, groupBy = 'room', interval = 'day', floor, roomId }) {
  const range = resolveRange({ from, to });
  const filters = { ...range, floor, roomId };
  const fmt = INTERVAL_FORMATS[interval];

  const keyCols = groupBy === 'floor' ? ['f.id as key_id', 'f.number as label'] : ['r.id as key_id', 'r.number as label', 'f.number as floor'];
  const groupCols = groupBy === 'floor' ? ['f.id', 'f.number'] : ['r.id', 'r.number', 'f.number'];

  const rows = await readingsQuery(filters)
    .select(keyCols)
    .select(db.raw('DATE_FORMAT(e.period_start, ?) AS period', [fmt]))
    .sum({ kwh: 'e.kwh' })
    .groupBy([...groupCols, 'period'])
    .orderBy('period');

  const series = new Map();
  for (const row of rows) {
    if (!series.has(row.key_id)) {
      series.set(row.key_id, { id: row.key_id, label: groupBy === 'floor' ? `Floor ${row.label}` : `Room ${row.label}`, ...(row.floor !== undefined ? { floor: row.floor } : {}), total: 0, points: [] });
    }
    const s = series.get(row.key_id);
    s.points.push({ period: row.period, kwh: round(row.kwh) });
    s.total += Number(row.kwh);
  }

  const top10 = await readingsQuery(filters)
    .select('r.id as room_id', 'r.number', 'f.number as floor')
    .sum({ kwh: 'e.kwh' })
    .groupBy('r.id', 'r.number', 'f.number')
    .orderBy('kwh', 'desc')
    .limit(10);

  const totalRow = await readingsQuery(filters).sum({ kwh: 'e.kwh' }).first();
  const list = [...series.values()].map((s) => ({ ...s, total: round(s.total) })).sort((a, b) => b.total - a.total);

  return {
    from: range.from,
    to: range.to,
    groupBy,
    interval,
    totalKwh: round(totalRow?.kwh ?? 0),
    series: list,
    top10: top10.map((t) => ({ roomId: t.room_id, number: t.number, floor: t.floor, kwh: round(t.kwh) })),
  };
}

/** Streams readings as CSV: one row per room per interval. */
export async function streamEnergyCsv(res, { from, to, interval = 'day', floor, roomId }) {
  const range = resolveRange({ from, to });
  const rows = await readingsQuery({ ...range, floor, roomId })
    .select('r.number as room', 'f.number as floor')
    .select(db.raw('DATE_FORMAT(e.period_start, ?) AS period', [INTERVAL_FORMATS[interval]]))
    .sum({ kwh: 'e.kwh' })
    .groupBy('r.number', 'f.number', 'period')
    .orderBy(['period', 'f.number', 'r.number']);

  const name = `energy_${interval}_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  const csv = stringify({ header: true, columns: ['period', 'floor', 'room', 'kwh'] });
  csv.pipe(res);
  for (const r of rows) csv.write({ period: r.period, floor: r.floor, room: r.room, kwh: round(r.kwh) });
  csv.end();
  await new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
  });
}

/** Saves readings, replacing any existing value for the same room, device and hour. */
export async function saveReadings(readings, source = 'adapter') {
  let saved = 0;
  for (let i = 0; i < readings.length; i += 500) {
    const chunk = readings.slice(i, i + 500).map((r) => ({
      room_id: r.roomId,
      device_id: r.deviceId ?? null,
      period_start: r.periodStart,
      kwh: r.kwh,
      source,
    }));
    if (!chunk.length) continue;
    await db('energy_readings').insert(chunk).onConflict(['room_id', 'device_id', 'period_start']).merge(['kwh', 'source']);
    saved += chunk.length;
  }
  return saved;
}

/** Pulls new readings from every enabled adapter that has meters. Run by a background job. */
export async function importEnergyReadings() {
  const adapters = await db('adapters').where({ is_enabled: true });
  let total = 0;
  for (const adapter of adapters) {
    const meters = await db('devices').where({ adapter_id: adapter.id, is_active: true, type: 'meter' }).whereNotNull('room_id');
    if (!meters.length) continue;
    const last = await db('energy_readings').whereIn('device_id', meters.map((m) => m.id)).max({ at: 'period_start' }).first();
    const since = last?.at ? new Date(new Date(last.at).getTime() + 3_600_000) : new Date(Date.now() - 48 * 3_600_000);
    try {
      const readings = await adapterFor(adapter).fetchEnergyReadings(meters, since);
      const byExternal = new Map(meters.map((m) => [m.external_id, m]));
      const rows = readings
        .filter((r) => byExternal.has(r.externalId) && Number.isFinite(Number(r.kwh)))
        .map((r) => ({ roomId: byExternal.get(r.externalId).room_id, deviceId: byExternal.get(r.externalId).id, periodStart: new Date(r.periodStart), kwh: Number(r.kwh) }));
      total += await saveReadings(rows);
    } catch (err) {
      console.error(`[energy] import from adapter ${adapter.name} failed:`, err.message);
    }
  }
  return total;
}
