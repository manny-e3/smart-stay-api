import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, resetDb, tokenFor } from './helpers.js';
import { db } from '../src/config/db.js';
import { ROLES, rolesFor } from '../src/core/permissions.js';

/**
 * Every admin endpoint with the permission it needs. A role that lacks the permission
 * must get 403; a role that has it must not. Adding an endpoint means adding it here.
 */
const ENDPOINTS = [
  ['get', '/admin/rooms/board', 'board:read'],
  ['get', '/admin/rooms/1', 'board:read'],
  ['post', '/admin/rooms/upload', 'mapping:manage', { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }],
  ['post', '/admin/rooms', 'mapping:manage', { number: '999', floor: 9 }],
  ['patch', '/admin/rooms/999', 'mapping:manage', { isActive: true }],
  ['delete', '/admin/rooms/999', 'mapping:manage'],
  ['get', '/admin/rooms/mapping', 'mapping:manage'],
  ['put', '/admin/rooms/mapping', 'mapping:manage', { floors: [] }],
  ['get', '/admin/rooms/mapping/adapters', 'mapping:manage'],
  ['post', '/admin/rooms/mapping/adapters/999/secret', 'mapping:manage'],
  ['post', '/admin/rooms/mapping/adapters/999/check', 'mapping:manage'],
  ['get', '/admin/requests', 'requests:read'],
  ['get', '/admin/requests/1', 'requests:read'],
  ['get', '/admin/requests/assignees', 'requests:write'],
  ['post', '/admin/requests', 'requests:write', {}],
  ['patch', '/admin/requests/1', 'requests:write', { note: 'x' }],
  ['get', '/admin/alerts', 'alerts:read'],
  ['get', '/admin/alerts/1', 'alerts:read'],
  ['patch', '/admin/alerts/1', 'alerts:resolve', { status: 'resolved', note: 'fixed it' }],
  ['get', '/admin/feedback', 'feedback:read'],
  ['get', '/admin/staff', 'staff:manage'],
  ['get', '/admin/staff/1', 'staff:manage'],
  ['post', '/admin/staff', 'staff:manage', {}],
  ['patch', '/admin/staff/999', 'staff:manage', { name: 'Someone' }],
  ['get', '/admin/settings', 'settings:manage'],
  ['put', '/admin/settings', 'settings:manage', {}],
  ['get', '/admin/audit', 'audit:read'],
  ['get', '/admin/rules', 'rules:manage'],
  ['get', '/admin/rules/1', 'rules:manage'],
  ['get', '/admin/rules/1/runs', 'rules:manage'],
  ['post', '/admin/rules', 'rules:manage', {}],
  ['patch', '/admin/rules/1', 'rules:manage', { isEnabled: false }],
  ['post', '/admin/rules/1/run', 'rules:manage'],
  ['get', '/admin/energy', 'energy:read'],
  ['get', '/admin/energy/export', 'energy:read'],
  ['get', '/admin/stays', 'stays:read'],
  ['get', '/admin/stays/999', 'stays:read'],
  ['post', '/admin/stays', 'stays:write', {}],
  ['patch', '/admin/stays/999', 'stays:write', { notes: 'x' }],
  ['post', '/admin/stays/999/check-in', 'stays:write'],
  ['post', '/admin/stays/999/check-out', 'stays:write'],
  ['post', '/admin/stays/999/move', 'stays:write', { roomId: 1 }],
  ['post', '/admin/stays/999/extend', 'stays:write', { departure: '2030-01-01' }],
  ['post', '/admin/stays/999/cancel', 'stays:write'],
  ['post', '/admin/stays/999/no-show', 'stays:write'],
  ['post', '/admin/stays/999/access-code', 'stays:write'],
  ['post', '/admin/stays/999/keys', 'stays:write'],
  ['get', '/admin/guests', 'stays:read'],
  ['get', '/admin/guests/999', 'stays:read'],
  ['post', '/admin/guests', 'stays:write', {}],
  ['patch', '/admin/guests/999', 'stays:write', { notes: 'x' }],
  ['post', '/admin/guests/999/anonymise', 'guests:anonymize'],
  ['get', '/admin/front-desk/today', 'stays:read'],
  ['get', '/admin/rooms/availability?from=2030-01-01&to=2030-01-02', 'stays:read'],
  ['get', '/admin/pms/connections', 'pms:manage'],
  ['post', '/admin/pms/connections', 'pms:manage', {}],
  ['patch', '/admin/pms/connections/999', 'pms:manage', { name: 'x' }],
  ['post', '/admin/pms/connections/999/secret', 'pms:manage'],
  ['post', '/admin/pms/connections/999/sync', 'pms:manage'],
  ['get', '/admin/pms/events', 'pms:manage'],
  ['post', '/admin/pms/events/999/retry', 'pms:manage'],
];

const tokens = {};
beforeAll(async () => {
  await resetDb();
  for (const role of ROLES) tokens[role] = await tokenFor(role);
});
afterAll(() => db.destroy());

describe('role checks on every admin endpoint', () => {
  for (const [method, path, permission, body] of ENDPOINTS) {
    for (const role of ROLES) {
      const allowed = rolesFor(permission).includes(role);
      it(`${method.toUpperCase()} ${path} as ${role} -> ${allowed ? 'allowed' : '403'}`, async () => {
        const req = api()[method](path).set('Authorization', `Bearer ${tokens[role]}`);
        const res = body ? await req.send(body) : await req;
        if (allowed) expect(res.status, JSON.stringify(res.body)).not.toBe(403);
        else expect(res.status).toBe(403);
        expect(res.status).not.toBe(401);
      });
    }
  }

  it('every admin endpoint needs a token', async () => {
    for (const [method, path] of ENDPOINTS) {
      const res = await api()[method](path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('rejects a forged token', async () => {
    const res = await api().get('/admin/rooms/board').set('Authorization', 'Bearer abc.def.ghi');
    expect(res.status).toBe(401);
  });
});
