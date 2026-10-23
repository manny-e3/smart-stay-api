import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { db, testConnection } from './config/db.js';
import { initSockets, closeSockets } from './core/sockets.js';
import { registerListeners } from './core/listeners.js';
import { startJobs, stopJobs } from './jobs/index.js';

const app = createApp();
const server = http.createServer(app);

initSockets(server);
registerListeners();

server.listen(env.port, async () => {
  console.log(`SmartStay API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  try {
    await testConnection();
    console.log(`MySQL connected (${env.db.database})`);
    startJobs();
  } catch (err) {
    console.error(`MySQL not connected: ${err.message}. Background jobs not started.`);
  }
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  stopJobs();
  await closeSockets();
  server.close(async () => {
    await db.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
