import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, as, seedHotel, checkIn } from './helpers.js';
import { db } from '../src/config/db.js';
import { outbox } from '../src/core/notifier.js';
import { submitFeedback } from '../src/modules/feedback/feedback.service.js';
import { tickRules } from '../src/modules/rules/rules.service.js';
import { importEnergyReadings, saveReadings } from '../src/modules/energy/energy.service.js';

let hotel;
beforeEach(async () => {
  await resetDb();
  hotel = await seedHotel();
});
afterAll(() => db.destroy());

describe('feedback', () => {
  it('lists with filters, photos, averages and distribution', async () => {
    await submitFeedback({ roomId: hotel.rooms[0].id, rating: 5, comment: 'Great', photos: ['https://cdn.test/a.jpg'] });
    await submitFeedback({ roomId: hotel.rooms[0].id, rating: 4 });
    await submitFeedback({ roomId: hotel.rooms[3].id, rating: 3 });

    const m = await as('manager');
    const all = (await m.get('/admin/feedback')).body.data;
    expect(all.summary).toMatchObject({ count: 3, average: 4, distribution: { 3: 1, 4: 1, 5: 1 } });
    expect(all.averages.periods).toHaveLength(1);
    expect(all.items.find((f) => f.rating === 5).photos[0].url).toBe('https://cdn.test/a.jpg');

    expect((await m.get('/admin/feedback?hasPhotos=true')).body.data.total).toBe(1);
    expect((await m.get('/admin/feedback?floor=2')).body.data.summary.average).toBe(3);
    expect((await m.get('/admin/feedback?groupBy=month')).body.data.averages.groupBy).toBe('month');
  });

  it('alerts managers about a low rating', async () => {
    await db('settings').where({ key: 'alert_email_recipients' }).update({ value: JSON.stringify(['gm@test.local']) });
    (await import('../src/modules/settings/settings.service.js')).clearSettingsCache();
    await submitFeedback({ roomId: hotel.rooms[0].id, rating: 4 });
    expect(outbox.emails).toHaveLength(0);
    await submitFeedback({ roomId: hotel.rooms[0].id, rating: 1, comment: 'Dirty room' });
    expect(outbox.emails[0]).toMatchObject({ to: ['gm@test.local'] });
    expect(outbox.emails[0].subject).toMatch(/Low rating \(1\/5\) from room 101/);
    expect(outbox.webPush.at(-1).roles).toEqual(['manager', 'admin']);
  });
});

describe('rules', () => {
  const ecoRule = { name: 'Eco when unsold', type: 'vacancy', target: { scope: 'all' }, conditions: { trigger: 'unsold', delayMinutes: 1 }, actions: [{ type: 'set_climate', mode: 'eco' }] };

  it('validates rules', async () => {
    const admin = await as('admin');
    expect((await admin.post('/admin/rules').send({ ...ecoRule, conditions: {} })).status).toBe(400);
    expect((await admin.post('/admin/rules').send({ ...ecoRule, type: 'schedule', cron: 'not cron' })).status).toBe(400);
    expect((await admin.post('/admin/rules').send({ ...ecoRule, actions: [{ type: 'set_climate', mode: 'cool', setpoint: 12 }] })).status).toBe(400);
  });

  it('vacancy rule puts empty rooms in eco once and records the run', async () => {
    await checkIn(hotel.rooms[0].id);
    const admin = await as('admin');
    const rule = (await admin.post('/admin/rules').send(ecoRule)).body.data;
    expect(rule.isEnabled).toBe(true);

    const runs = await tickRules();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'success', roomsMatched: 5, commandsSent: 5 });

    const occupiedThermostat = await db('devices').where({ room_id: hotel.rooms[0].id, type: 'thermostat' }).first();
    const vacantThermostat = await db('devices').where({ room_id: hotel.rooms[1].id, type: 'thermostat' }).first();
    expect((await db('device_states').where({ device_id: vacantThermostat.id }).first()).state).toMatchObject({ mode: 'eco', setpoint: 26 });
    expect((await db("device_states").where({ device_id: occupiedThermostat.id }).first()).state.mode).toBe("cool");

    // Already in eco: nothing sent and nothing recorded
    expect(await tickRules()).toHaveLength(0);

    const detail = (await admin.get(`/admin/rules/${rule.id}`)).body.data;
    expect(detail).toMatchObject({ lastRunStatus: 'success' });
    expect(detail.recentRuns).toHaveLength(1);
  });

  it('eco switch in settings pauses vacancy rules', async () => {
    const admin = await as('admin');
    await admin.post('/admin/rules').send(ecoRule);
    await admin.put('/admin/settings').send({ eco_enabled: false });
    expect(await tickRules()).toHaveLength(0);
  });

  it('schedule rule runs once per slot, and can be disabled or run by hand', async () => {
    const admin = await as('admin');
    const rule = (await admin.post('/admin/rules').send({ name: 'Lights off', type: 'schedule', cron: '* * * * *', target: { scope: 'floors', floors: [2] }, actions: [{ type: 'set_climate', mode: 'off' }] })).body.data;
    expect(rule.nextRunAt).toBeTruthy();
    await db('rules').where({ id: rule.id }).update({ created_at: new Date(Date.now() - 5 * 60_000) });

    const runs = await tickRules();
    expect(runs[0]).toMatchObject({ trigger: 'schedule', roomsMatched: 3, commandsSent: 3 });
    expect(await tickRules()).toHaveLength(0);

    const disabled = await admin.patch(`/admin/rules/${rule.id}`).send({ isEnabled: false });
    expect(disabled.body.data.isEnabled).toBe(false);
    expect((await db('audit_log').where({ action: 'rule.disable' }).first())).toBeTruthy();

    const manual = await admin.post(`/admin/rules/${rule.id}/run`);
    expect(manual.body.data).toMatchObject({ trigger: 'manual', status: 'success' });
    expect((await admin.get(`/admin/rules/${rule.id}/runs`)).body.data.total).toBe(2);
  });

  it('records failed commands and raises an alert', async () => {
    await db('adapters').where({ id: hotel.adapterId }).update({ config: JSON.stringify({ failCommands: true }) });
    const admin = await as('admin');
    const rule = (await admin.post('/admin/rules').send({ ...ecoRule, target: { scope: 'rooms', roomIds: [hotel.rooms[1].id] } })).body.data;
    const [run] = await tickRules();
    expect(run).toMatchObject({ status: 'failed', commandsFailed: 1 });
    expect(await db('alerts').where({ type: 'command_failed' }).first()).toBeTruthy();
    expect(rule.id).toBeTruthy();
  });
});

describe('energy', () => {
  it('imports readings from adapters', async () => {
    const n = await importEnergyReadings();
    expect(n).toBeGreaterThan(6 * 40);
    expect(await importEnergyReadings()).toBeLessThan(n);
  });

  it('charts by room and floor with top 10 and CSV export', async () => {
    const day = new Date(Date.UTC(2026, 9, 1, 10));
    const readings = hotel.rooms.map((r, i) => ({ roomId: r.id, periodStart: day, kwh: i + 1 }));
    await saveReadings(readings, 'test');
    const m = await as('manager');
    const q = 'from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z';

    const byRoom = (await m.get(`/admin/energy?${q}`)).body.data;
    expect(byRoom.totalKwh).toBe(21);
    expect(byRoom.top10[0]).toMatchObject({ number: '203', kwh: 6 });
    expect(byRoom.series[0].points).toEqual([{ period: '2026-10-01', kwh: 6 }]);

    const byFloor = (await m.get(`/admin/energy?${q}&groupBy=floor`)).body.data;
    expect(byFloor.series.map((s) => [s.label, s.total])).toEqual([['Floor 2', 15], ['Floor 1', 6]]);

    const csv = await m.get(`/admin/energy/export?${q}`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toBe('period,floor,room,kwh');
    expect(csv.text).toContain('2026-10-01,1,101,1');

    expect((await m.get('/admin/energy?from=2026-10-02&to=2026-10-01')).status).toBe(400);
  });
});
