import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, as, api } from './helpers.js';
import { db } from '../src/config/db.js';

let staff;
beforeEach(async () => {
  staff = await resetDb();
});
afterAll(() => db.destroy());

describe('staff accounts', () => {
  it('creates, lists and edits staff', async () => {
    const admin = await as('admin');
    const created = await admin.post('/admin/staff').send({ name: 'New Person', email: 'New@Test.local', role: 'service', password: 'Welcome12345' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ email: 'new@test.local', role: 'service', isActive: true });
    expect(created.body.data.password_hash).toBeUndefined();

    const list = await admin.get('/admin/staff?role=service');
    expect(list.body.data.items.map((s) => s.email)).toContain('new@test.local');
    const search = await admin.get('/admin/staff?q=new%20pers');
    expect(search.body.data.items.map((s) => s.email)).toEqual(['new@test.local']);

    const edited = await admin.patch(`/admin/staff/${created.body.data.id}`).send({ role: 'maintenance', isActive: false });
    expect(edited.body.data).toMatchObject({ role: 'maintenance', isActive: false });

    const logged = await db('audit_log').where({ action: 'staff.deactivate', entity_id: String(created.body.data.id) }).first();
    expect(logged).toBeTruthy();
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const admin = await as('admin');
    expect((await admin.post('/admin/staff').send({ name: 'Dup', email: 'service@test.local', role: 'service', password: 'Welcome12345' })).status).toBe(409);
    expect((await admin.post('/admin/staff').send({ name: 'Weak', email: 'weak@test.local', role: 'service', password: 'abc' })).status).toBe(400);
  });

  it('stops admins locking themselves out', async () => {
    const admin = await as('admin');
    expect((await admin.patch(`/admin/staff/${staff.admin.id}`).send({ isActive: false })).status).toBe(400);
    expect((await admin.patch(`/admin/staff/${staff.admin.id}`).send({ role: 'manager' })).status).toBe(400);
  });

  it('lets an admin demote another admin while one admin remains', async () => {
    const [otherId] = await db('staff').insert({ name: 'Admin 2', email: 'admin2@test.local', role: 'admin', password_hash: 'x' });
    const admin = await as('admin');
    const res = await admin.patch(`/admin/staff/${otherId}`).send({ role: 'manager' });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('manager');
  });

  it('resets a locked account', async () => {
    await db('staff').where({ id: staff.service.id }).update({ locked_until: new Date(Date.now() + 600_000) });
    const admin = await as('admin');
    expect((await admin.patch(`/admin/staff/${staff.service.id}`).send({ unlock: true })).status).toBe(200);
    expect((await api().post('/staff/login').send({ email: 'service@test.local', password: 'TestPassword123' })).status).toBe(200);
  });
});

describe('hotel settings', () => {
  it('reads defaults and saves a partial update', async () => {
    const admin = await as('admin');
    const get = await admin.get('/admin/settings');
    expect(get.body.data.escalation_minutes).toBe(15);

    const put = await admin.put('/admin/settings').send({ escalation_minutes: 10, alert_email_recipients: ['ops@test.local'] });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ escalation_minutes: 10, alert_email_recipients: ['ops@test.local'], ac_min_temp: 18 });

    const audit = await db('audit_log').where({ action: 'settings.update' }).first();
    expect(audit.details.escalation_minutes).toEqual({ from: 15, to: 10 });
  });

  it('rejects an invalid AC range and unknown keys', async () => {
    const admin = await as('admin');
    expect((await admin.put('/admin/settings').send({ ac_min_temp: 30, ac_max_temp: 20 })).status).toBe(400);
    expect((await admin.put('/admin/settings').send({ not_a_setting: 1 })).status).toBe(400);
  });
});

describe('audit log', () => {
  it('searches by action prefix, staff and text', async () => {
    const admin = await as('admin');
    await admin.put('/admin/settings').send({ phones_per_room: 3 });
    await (await as('manager')).get('/admin/audit');

    const manager = await as('manager');
    const all = await manager.get('/admin/audit');
    expect(all.body.data.total).toBeGreaterThanOrEqual(3);

    const logins = await manager.get('/admin/audit?action=auth.');
    expect(logins.body.data.items.every((i) => i.action.startsWith('auth.'))).toBe(true);

    const byStaff = await manager.get(`/admin/audit?staffId=${staff.admin.id}&action=settings.update`);
    expect(byStaff.body.data.items).toHaveLength(1);
    expect(byStaff.body.data.items[0].actor).toMatchObject({ type: 'staff', name: 'Test admin' });

    const text = await manager.get('/admin/audit?q=phones_per_room');
    expect(text.body.data.total).toBe(1);
  });

  it('health endpoints respond', async () => {
    expect((await api().get('/health')).status).toBe(200);
    expect((await api().get('/health/db')).body.database).toBe('connected');
  });
});
