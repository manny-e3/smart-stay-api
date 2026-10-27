import * as Energy from '../models/energy.model.js';
import * as Device from '../models/device.model.js';
import { adapterFor } from '../integrations/devices/index.js';
import { badRequest } from '../utils/errors.js';

/** Energy analytics (Release 2): charts, top 10, CSV export and importing readings from meters. */

const DEFAULT_DAYS = 7;
const MAX_RANGE_DAYS = 400;
const round = (n) => Math.round(Number(n) * 1000) / 1000;

export function resolveRange({ from, to }) {
  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - DEFAULT_DAYS * 86_400_000);
  return { from: start, to: end };
}

/** Limits that keep queries reasonable: at most 400 days, and hourly data for 31 days. */
function assertRange(q) {
  if (q.from && q.to && (q.to - q.from) / 86_400_000 > MAX_RANGE_DAYS) throw badRequest(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  if (q.interval === 'hour' && (q.to ?? new Date()) - (q.from ?? new Date(Date.now() - 7 * 86_400_000)) > 31 * 86_400_000) {
    throw badRequest('Hourly data is limited to 31 days');
  }
}

/** Energy use grouped by room or floor over hour/day/month buckets, plus the top 10 rooms. */
export async function getEnergy(query) {
  assertRange(query);
  const { groupBy = 'room', interval = 'day', floor, roomId } = query;
  const range = resolveRange(query);
  const filters = { ...range, floor, roomId };

  const series = new Map();
  for (const row of await Energy.series(filters, groupBy, interval)) {
    if (!series.has(row.key_id)) {
      series.set(row.key_id, { id: row.key_id, label: groupBy === 'floor' ? `Floor ${row.label}` : `Room ${row.label}`, ...(row.floor !== undefined ? { floor: row.floor } : {}), total: 0, points: [] });
    }
    const s = series.get(row.key_id);
    s.points.push({ period: row.period, kwh: round(row.kwh) });
    s.total += Number(row.kwh);
  }

  const [top10, total] = await Promise.all([Energy.top10Rooms(filters), Energy.totalKwh(filters)]);
  return {
    from: range.from,
    to: range.to,
    groupBy,
    interval,
    totalKwh: round(total),
    series: [...series.values()].map((s) => ({ ...s, total: round(s.total) })).sort((a, b) => b.total - a.total),
    top10: top10.map((t) => ({ roomId: t.room_id, number: t.number, floor: t.floor, kwh: round(t.kwh) })),
  };
}

/** CSV export: one row per room per interval, and a file name. */
export async function getEnergyExport(query) {
  assertRange(query);
  const { interval = 'day', floor, roomId } = query;
  const range = resolveRange(query);
  const rows = (await Energy.exportRows({ ...range, floor, roomId }, interval)).map((r) => ({ period: r.period, floor: r.floor, room: r.room, kwh: round(r.kwh) }));
  const filename = `energy_${interval}_${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.csv`;
  return { filename, columns: ['period', 'floor', 'room', 'kwh'], rows };
}

/** Saves readings, replacing any existing value for the same room, device and hour. */
export async function saveReadings(readings, source = 'adapter') {
  let saved = 0;
  for (let i = 0; i < readings.length; i += 500) {
    const chunk = readings.slice(i, i + 500).map((r) => ({ room_id: r.roomId, device_id: r.deviceId ?? null, period_start: r.periodStart, kwh: r.kwh, source }));
    if (!chunk.length) continue;
    await Energy.upsertMany(chunk);
    saved += chunk.length;
  }
  return saved;
}

/** Background job: pulls new readings from every enabled adapter that has meters. */
export async function importEnergyReadings() {
  let total = 0;
  for (const adapter of await Device.listEnabledAdapters()) {
    const meters = await Device.listMetersForAdapter(adapter.id);
    if (!meters.length) continue;
    const last = await Energy.latestReadingAt(meters.map((m) => m.id));
    const since = last ? new Date(new Date(last).getTime() + 3_600_000) : new Date(Date.now() - 48 * 3_600_000);
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
