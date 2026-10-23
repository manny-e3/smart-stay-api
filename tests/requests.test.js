import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, as, seedHotel, checkIn, settle } from './helpers.js';
import { db } from '../src/config/db.js';
import { outbox } from '../src/core/notifier.js';
import { escalateOverdue } from '../src/modules/requests/requests.service.js';
import { bus, EVENTS } from '../src/core/events.js';

let staff;
let hotel;
beforeEach(async () => {
  staff = await resetDb();
  hotel = await seedHotel();
});
afterAll(() => db.destroy());

describe('request queue', () => {
  it('creates a request on behalf of the guest in the room', async () => {
    const room = hotel.rooms[0];
    const { guestId, stayId } = await checkIn(room.id, 'Ada');
    const service = await as('service');
    const res = await service.post('/admin/requests').send({ roomId: room.id, category: 'housekeeping', description: 'Towels', priority: 'high' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'new', source: 'staff', priority: 'high', stayId, guest: { id: guestId, name: 'Ada Test' }, room: { number: room.number } });
  });

  it('assigns, moves through statuses and keeps the history', async () => {
    const room = hotel.rooms[1];
    const { stayId } = await checkIn(room.id);
    await db('guest_devices').insert({ guest_id: (await db('stays').where({ id: stayId }).first()).guest_id, stay_id: stayId, push_token: 'tok-1', platform: 'ios' });
    const manager = await as('manager');
    const created = (await manager.post('/admin/requests').send({ roomId: room.id, category: 'amenities' })).body.data;

    const assigned = await manager.patch(`/admin/requests/${created.id}`).send({ assignedTo: staff.service.id });
    expect(assigned.body.data).toMatchObject({ status: 'assigned', assignee: { id: staff.service.id } });

    const service = await as('service');
    const started = await service.patch(`/admin/requests/${created.id}`).send({ status: 'in_progress', note: 'On my way' });
    expect(started.body.data.status).toBe('in_progress');
    const done = await service.patch(`/admin/requests/${created.id}`).send({ status: 'done' });
    expect(done.body.data.status).toBe('done');
    expect(done.body.data.completedAt).toBeTruthy();

    const detail = (await service.get(`/admin/requests/${created.id}`)).body.data;
    expect(detail.history.map((h) => h.action)).toEqual(['created', 'assigned', 'status_changed', 'status_changed', 'status_changed']);
    expect(detail.history[3]).toMatchObject({ fromStatus: 'assigned', toStatus: 'in_progress', note: 'On my way' });

    // Guest gets a push on every status change
    expect(outbox.guestPush.map((p) => p.data.status)).toEqual(['assigned', 'in_progress', 'done']);
    expect(outbox.guestPush[0].devices).toBe(1);
  });

  it('blocks invalid status changes and edits to closed requests', async () => {
    const service = await as('service');
    const r = (await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'food' })).body.data;
    expect((await service.patch(`/admin/requests/${r.id}`).send({ status: 'assigned' })).status).toBe(400);
    await service.patch(`/admin/requests/${r.id}`).send({ status: 'cancelled' });
    expect((await service.patch(`/admin/requests/${r.id}`).send({ status: 'in_progress' })).status).toBe(400);
    // Notes are still allowed on closed requests
    expect((await service.patch(`/admin/requests/${r.id}`).send({ note: 'Guest changed mind' })).status).toBe(200);
  });

  it('lists assignable staff with their open request counts', async () => {
    const manager = await as('manager');
    const r = (await manager.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'food' })).body.data;
    await manager.patch(`/admin/requests/${r.id}`).send({ assignedTo: staff.service.id });
    const list = (await (await as('service')).get('/admin/requests/assignees')).body.data;
    expect(list.map((s) => s.role).sort()).toEqual(['admin', 'manager', 'service']);
    expect(list.find((s) => s.id === staff.service.id).openRequests).toBe(1);
  });

  it('only assigns to active staff who handle requests', async () => {
    const service = await as('service');
    const r = (await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'food' })).body.data;
    expect((await service.patch(`/admin/requests/${r.id}`).send({ assignedTo: staff.maintenance.id })).status).toBe(400);
    expect((await service.patch(`/admin/requests/${r.id}`).send({ assignedTo: 99999 })).status).toBe(400);
  });

  it('lists with filters and open counts', async () => {
    const service = await as('service');
    await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'food' });
    const r2 = (await service.post('/admin/requests').send({ roomId: hotel.rooms[1].id, category: 'laundry', priority: 'urgent' })).body.data;
    await service.patch(`/admin/requests/${r2.id}`).send({ assignedTo: staff.service.id });

    const all = (await service.get('/admin/requests?status=new,assigned')).body.data;
    expect(all.total).toBe(2);
    expect(all.items[0].priority).toBe('urgent');
    expect(all.openCounts).toEqual({ new: 1, assigned: 1, in_progress: 0 });

    const mine = (await service.get('/admin/requests?assignedTo=me')).body.data;
    expect(mine.items.map((i) => i.id)).toEqual([r2.id]);
  });

  it('publishes live events and notifies the queue', async () => {
    const seen = [];
    const listener = (r) => seen.push(r.id);
    bus.on(EVENTS.REQUEST_CREATED, listener);
    const service = await as('service');
    const r = (await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'food' })).body.data;
    await settle();
    bus.off(EVENTS.REQUEST_CREATED, listener);
    expect(seen).toContain(r.id);
    expect(outbox.webPush.some((p) => p.payload.data.requestId === r.id && p.payload.data.sound)).toBe(true);
  });
});

describe('escalation', () => {
  it('escalates requests older than the set time and tells managers', async () => {
    const service = await as('service');
    const old = (await service.post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'food' })).body.data;
    const fresh = (await service.post('/admin/requests').send({ roomId: hotel.rooms[1].id, category: 'food' })).body.data;
    await db('requests').where({ id: old.id }).update({ created_at: new Date(Date.now() - 20 * 60_000) });
    await db('settings').where({ key: 'alert_email_recipients' }).update({ value: JSON.stringify(['ops@test.local']) });
    (await import('../src/modules/settings/settings.service.js')).clearSettingsCache();

    const escalated = await escalateOverdue();
    expect(escalated.map((r) => r.id)).toEqual([old.id]);
    expect((await escalateOverdue()).length).toBe(0);

    const list = (await service.get('/admin/requests')).body.data.items;
    expect(list[0]).toMatchObject({ id: old.id, escalated: true });
    expect(list.find((r) => r.id === fresh.id).escalated).toBe(false);
    expect(outbox.emails.some((e) => e.subject.includes('escalated'))).toBe(true);

    const history = (await service.get(`/admin/requests/${old.id}`)).body.data.history;
    expect(history.at(-1)).toMatchObject({ action: 'escalated', actor: { type: 'system' } });
  });
});
