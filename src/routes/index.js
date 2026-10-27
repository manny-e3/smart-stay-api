import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from '../config/env.js';
import { buildOpenApi } from '../docs/openapi.js';
import { authenticate } from '../middleware/auth.js';
import { testConnection } from '../config/db.js';
import authRoutes from './auth.routes.js';
import staffRoutes from './staff.routes.js';
import roomsRoutes from './rooms.routes.js';
import requestsRoutes from './requests.routes.js';
import alertsRoutes from './alerts.routes.js';
import feedbackRoutes from './feedback.routes.js';
import settingsRoutes from './settings.routes.js';
import auditRoutes from './audit.routes.js';
import rulesRoutes from './rules.routes.js';
import energyRoutes from './energy.routes.js';
import integrationsRoutes from './integrations.routes.js';
import staysRoutes from './stays.routes.js';
import guestsRoutes from './guests.routes.js';
import frontDeskRoutes from './frontDesk.routes.js';
import guestAppRoutes from './guestApp.routes.js';
import mediaRoutes from './media.routes.js';
import { pmsAdminRouter, pmsWebhookRouter } from './pms.routes.js';
import posRoutes from './pos.routes.js';
import inventoryRoutes from './inventory.routes.js';
import procurementRoutes from './procurement.routes.js';
import financeRoutes from './finance.routes.js';
import aiRoutes from './ai.routes.js';

export function buildRoutes() {
  const root = Router();

  root.get('/health', (req, res) => res.json({ success: true, status: 'ok', uptime: process.uptime() }));
  root.get('/health/db', async (req, res) => {
    await testConnection();
    res.json({ success: true, database: 'connected' });
  });

  if (env.docsEnabled) {
    root.get('/docs/openapi.json', (req, res) => res.json(buildOpenApi({ serverUrl: `${req.protocol}://${req.get('host')}` })));
    root.use('/docs', swaggerUi.serve, swaggerUi.setup(null, { customSiteTitle: 'SmartStay API', swaggerOptions: { url: '/docs/openapi.json', persistAuthorization: true, docExpansion: 'none', filter: true } }));
  }

  root.use('/staff', authRoutes);
  root.use('/guest/ai', aiRoutes);
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
  admin.use('/stays', staysRoutes);
  admin.use('/guests', guestsRoutes);
  admin.use('/front-desk', frontDeskRoutes);
  admin.use('/pms', pmsAdminRouter);
  admin.use('/pos', posRoutes);
  admin.use('/inventory', inventoryRoutes);
  admin.use('/procurement', procurementRoutes);
  admin.use('/finance', financeRoutes);
  admin.use('/ai', aiRoutes);
  root.use('/admin', admin);

  return root;
}
