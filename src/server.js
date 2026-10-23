import http from 'node:http';
import fs from 'node:fs';
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

const socketPath = process.env.SOCKET_PATH;
if (socketPath) {
  try { fs.unlinkSync(socketPath); } catch {}
}

const listenTarget = socketPath || env.port;

server.listen(listenTarget, async () => {
  if (socketPath) {
    try { fs.chmodSync(socketPath, 0o777); } catch {}
    console.log(SmartStay API listening on socket );
  } else {
    console.log(SmartStay API listening on http://localhost: ());
  }
  try {
    await testConnection();
    console.log(MySQL connected ());
    startJobs();
  } catch (err) {
    console.error(MySQL not connected: . Background jobs not started.);
  }
});

let companionServer = null;
if (!socketPath) {
  const companionPort = Number(env.port) === 5000 ? 6000 : 5000;
  companionServer = http.createServer(app);
  initSockets(companionServer);
  companionServer.listen(companionPort, () => {
    console.log(SmartStay API companion listening on http://localhost:);
  }).on('error', (err) => {
    console.warn(Companion port  notice: );
  });
}

async function shutdown(signal) {
  console.log(${signal} received, shutting down);
  stopJobs();
  await closeSockets();
  if (companionServer) companionServer.close(() => {});
  if (socketPath) {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  server.close(async () => {
    await db.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
