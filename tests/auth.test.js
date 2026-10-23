import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api, resetDb, PASSWORD, as } from './helpers.js';
import { db } from '../src/config/db.js';
import { generateCode } from '../src/core/totp.js';

let staff;
beforeEach(async () => {
  staff = await resetDb();
});
afterAll(() => db.destroy());

const login = (email, password = PASSWORD, extra = {}) => api().post('/staff/login').send({ email, password, ...extra });

describe('staff login', () => {
  it('returns tokens and the staff profile', async () => {
    const res = await login('manager@test.local');
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.staff).toMatchObject({ email: 'manager@test.local', role: 'manager' });
    expect(res.headers['set-cookie'][0]).toMatch(/ss_refresh=.*HttpOnly/);
  });

  it('rejects a wrong password without saying whether the email exists', async () => {
    const wrong = await login('manager@test.local', 'nope');
    const unknown = await login('nobody@test.local', 'nope');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('locks the account after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) await login('service@test.local', 'wrong');
    const res = await login('service@test.local');
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
    const audit = await db('audit_log').where({ action: 'auth.locked' }).first();
    expect(audit).toBeTruthy();
  });

  it('validates the login body', async () => {
    const res = await api().post('/staff/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('rejects deactivated staff', async () => {
    await db('staff').where({ id: staff.service.id }).update({ is_active: false });
    expect((await login('service@test.local')).status).toBe(401);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and detects reuse', async () => {
    const first = await login('admin@test.local');
    const r1 = first.body.data.refreshToken;
    const second = await api().post('/staff/refresh').send({ refreshToken: r1 });
    expect(second.status).toBe(200);
    const r2 = second.body.data.refreshToken;
    expect(r2).not.toBe(r1);

    // Reusing the old token ends every session for the account.
    expect((await api().post('/staff/refresh').send({ refreshToken: r1 })).status).toBe(401);
    expect((await api().post('/staff/refresh').send({ refreshToken: r2 })).status).toBe(401);
  });

  it('refreshes from the httpOnly cookie', async () => {
    const agent = (await import('supertest')).default.agent((await import('./helpers.js')).app);
    await agent.post('/staff/login').send({ email: 'admin@test.local', password: PASSWORD });
    const res = await agent.post('/staff/refresh');
    expect(res.status).toBe(200);
  });

  it('logout makes the access token stop working', async () => {
    const { body } = await login('admin@test.local');
    const token = body.data.accessToken;
    expect((await api().get('/staff/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    await api().post('/staff/logout').set('Authorization', `Bearer ${token}`).send({ refreshToken: body.data.refreshToken });
    const after = await api().get('/staff/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_INVALID');
  });

  it('deactivating a staff member ends their sessions at once', async () => {
    const { body } = await login('service@test.local');
    const admin = await as('admin');
    await admin.patch(`/admin/staff/${staff.service.id}`).send({ isActive: false });
    expect((await api().get('/staff/me').set('Authorization', `Bearer ${body.data.accessToken}`)).status).toBe(401);
  });

  it('works under the /api prefix too', async () => {
    const res = await api().post('/api/staff/login').send({ email: 'admin@test.local', password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('one-time code', () => {
  it('sets up, requires the code at login, and disables', async () => {
    const me = await as('manager');
    const setup = await me.post('/staff/me/otp/setup');
    const { secret } = setup.body.data;
    expect(setup.body.data.otpauthUrl).toContain('otpauth://totp/');

    expect((await me.post('/staff/me/otp/enable').send({ code: '000000' })).status).toBe(400);
    expect((await me.post('/staff/me/otp/enable').send({ code: generateCode(secret) })).status).toBe(200);

    const noCode = await login('manager@test.local');
    expect(noCode.status).toBe(401);
    expect(noCode.body.code).toBe('OTP_REQUIRED');

    const withCode = await login('manager@test.local', PASSWORD, { otp: generateCode(secret) });
    expect(withCode.status).toBe(200);

    const me2 = withCode.body.data.accessToken;
    const off = await api().post('/staff/me/otp/disable').set('Authorization', `Bearer ${me2}`).send({ code: generateCode(secret) });
    expect(off.status).toBe(200);
    expect((await login('manager@test.local')).status).toBe(200);
  });
});

describe('password change', () => {
  it('needs the current password and a strong new one', async () => {
    const me = await as('service');
    expect((await me.post('/staff/me/password').send({ currentPassword: 'bad', newPassword: 'NewPassword1234' })).status).toBe(400);
    expect((await me.post('/staff/me/password').send({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await me.post('/staff/me/password').send({ currentPassword: PASSWORD, newPassword: 'NewPassword1234' })).status).toBe(200);
    expect((await login('service@test.local', 'NewPassword1234')).status).toBe(200);
  });
});
