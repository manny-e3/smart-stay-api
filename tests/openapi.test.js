import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, resetDb, tokenFor } from './helpers.js';
import { db } from '../src/config/db.js';
import { buildOpenApi } from '../src/docs/openapi.js';
import authRoutes from '../src/routes/auth.routes.js';
import staffRoutes from '../src/routes/staff.routes.js';
import roomsRoutes from '../src/routes/rooms.routes.js';
import requestsRoutes from '../src/routes/requests.routes.js';
import alertsRoutes from '../src/routes/alerts.routes.js';
import feedbackRoutes from '../src/routes/feedback.routes.js';
import settingsRoutes from '../src/routes/settings.routes.js';
import auditRoutes from '../src/routes/audit.routes.js';
import rulesRoutes from '../src/routes/rules.routes.js';
import energyRoutes from '../src/routes/energy.routes.js';
import integrationsRoutes from '../src/routes/integrations.routes.js';
import guestRoutes from '../src/routes/guestApp.routes.js';
import staysRoutes from '../src/routes/stays.routes.js';
import guestsRoutes from '../src/routes/guests.routes.js';
import frontDeskRoutes from '../src/routes/frontDesk.routes.js';
import { pmsAdminRouter, pmsWebhookRouter } from '../src/routes/pms.routes.js';
import mediaRoutes from '../src/routes/media.routes.js';

/** Same mount points as src/routes/index.js. */
const MOUNTS = {
  '/staff': authRoutes,
  '/guest': guestRoutes,
  '/integrations/pms': pmsWebhookRouter,
  '/integrations': integrationsRoutes,
  '/admin/staff': staffRoutes,
  '/admin/rooms': roomsRoutes,
  '/admin/requests': requestsRoutes,
  '/admin/alerts': alertsRoutes,
  '/admin/feedback': feedbackRoutes,
  '/admin/settings': settingsRoutes,
  '/admin/audit': auditRoutes,
  '/admin/rules': rulesRoutes,
  '/admin/energy': energyRoutes,
  '/admin/stays': staysRoutes,
  '/admin/guests': guestsRoutes,
  '/admin/front-desk': frontDeskRoutes,
  '/admin/pms': pmsAdminRouter,
  '/media': mediaRoutes,
};

function appRoutes() {
  const out = [];
  for (const [mount, router] of Object.entries(MOUNTS)) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const path = `${mount}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:(\w+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods)) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

const spec = buildOpenApi();
const documented = Object.entries(spec.paths)
  .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
  .filter((op) => !op.endsWith(' /health') && !op.endsWith(' /health/db'))
  .sort();

let tokens;
beforeAll(async () => {
  await resetDb();
  tokens = { staff: await tokenFor('admin') };
});
afterAll(() => db.destroy());

describe('API documentation', () => {
  it('documents every route in the app', () => {
    const missing = appRoutes().filter((r) => !documented.includes(r));
    expect(missing, 'Add these routes to src/docs/openapi.js').toEqual([]);
  });

  it('every documented operation exists in the app', async () => {
    const unknown = [];
    for (const op of documented) {
      const [method, path] = op.split(' ');
      const url = path.replace(/\{\w+\}/g, '999999');
      const res = await api()[method.toLowerCase()](url).set('Authorization', `Bearer ${tokens.staff}`).send({});
      if (res.status === 404 && /^Route not found/.test(res.body.message || '')) unknown.push(op);
    }
    expect(unknown).toEqual([]);
  });

  it('serves the spec and the docs page', async () => {
    const json = await api().get('/docs/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.openapi).toBe('3.1.0');
    const page = await api().get('/docs/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('swagger-ui');
  });
});
