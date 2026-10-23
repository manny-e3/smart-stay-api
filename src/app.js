import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { buildRoutes } from './routes.js';
import { notFoundHandler, errorHandler } from './core/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.resolve(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

export function createApp() {
  const app = express();

  if (env.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigins.includes('*') ? true : env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '20mb' }));
  app.use(cookieParser());
  if (!env.isTest) app.use(morgan(env.isProd ? 'combined' : 'dev'));
  if (!env.isTest) {
    app.use(rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
  }

  // Static uploads directory for room photos & media
  app.use('/uploads', express.static(uploadsDir));

  app.get('/', (req, res) => res.json({ success: true, message: 'SmartStay API is running' }));
  // Routes are served at the root (/staff, /admin, /integrations) and under /api for proxies that need a prefix.
  const routes = buildRoutes();
  app.use('/api', routes);
  app.use('/', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
