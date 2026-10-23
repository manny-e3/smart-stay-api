import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { buildOpenApi } from './docs/openapi.js';
import { authenticate } from './core/auth.js';
import { db } from './config/db.js';
import authRoutes from './modules/auth/auth.routes.js';
import staffRoutes from './modules/staff/staff.routes.js';
import roomsRoutes from './modules/rooms/rooms.routes.js';
import requestsRoutes from './modules/requests/requests.routes.js';
import alertsRoutes from './modules/alerts/alerts.routes.js';
import feedbackRoutes from './modules/feedback/feedback.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import rulesRoutes from './modules/rules/rules.routes.js';
import energyRoutes from './modules/energy/energy.routes.js';
import integrationsRoutes from './modules/integrations/integrations.routes.js';
import { staysRouter, guestsRouter, frontDeskRouter } from './modules/stays/stays.routes.js';
import guestAppRoutes from './modules/guest/guest.routes.js';
import mediaRoutes from './modules/media/media.routes.js';
import { pmsAdminRouter, pmsWebhookRouter } from './modules/pms/pms.routes.js';

export function buildRoutes() {
  const root = Router();

  root.get('/health', (req, res) => res.json({ success: true, status: 'ok', uptime: process.uptime() }));
  root.get('/health/db', async (req, res) => {
    await db.raw('SELECT 1');
    res.json({ success: true, database: 'connected' });
  });

  if (env.docsEnabled) {
    root.get('/docs/openapi.json', (req, res) => res.json(buildOpenApi({ serverUrl: `${req.protocol}://${req.get('host')}` })));
    root.use('/docs', swaggerUi.serve, swaggerUi.setup(null, { customSiteTitle: 'SmartStay API', swaggerOptions: { url: '/docs/openapi.json', persistAuthorization: true, docExpansion: 'none', filter: true } }));
  }

  root.use('/staff', authRoutes);
  root.use('/guest', guestAppRoutes);
  root.use('/media', mediaRoutes);
  root.use('/integrations/pms', pmsWebhookRouter);
  root.use('/integrations', integrationsRoutes);

  const admin = Router();
  admin.use(authenticate);
  admin.use('/staff', staffRoutes);
  admin.use('/rooms', roomsRoutes);
  admin.use('/requests', requestsRoutes);
  admin.use('/alerts', alertsRoutes);
  admin.use('/feedback', feedbackRoutes);
  admin.use('/settings', settingsRoutes);
  admin.use('/audit', auditRoutes);
  admin.use('/rules', rulesRoutes);
  admin.use('/energy', energyRoutes);
  admin.use('/stays', staysRouter);
  admin.use('/guests', guestsRouter);
  admin.use('/front-desk', frontDeskRouter);
  admin.use('/pms', pmsAdminRouter);
  root.use('/admin', admin);

  return root;
}
