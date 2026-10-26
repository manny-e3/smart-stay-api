import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { db, testConnection } from './config/db.js';
import { initSockets, closeSockets } from './core/sockets.js';
import { registerListeners } from './core/listeners.js';
import { startJobs, stopJobs } from './jobs/index.js';

const app = createApp();
const server = http.createServer(app);

// One Socket.IO server for every port/socket the API listens on.
initSockets(server);
registerListeners();

// Hostinger (and similar hosts) proxy to a UNIX socket instead of a TCP port.
const socketPath = process.env.SOCKET_PATH;
if (socketPath) {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // No stale socket file to remove.
  }
}

const listenTarget = socketPath || env.port;

server.listen(listenTarget, async () => {
  if (socketPath) {
    try {
      fs.chmodSync(socketPath, 0o777);
    } catch {
      // Some hosts manage socket permissions themselves.
    }
    console.log(`SmartStay API listening on socket ${socketPath} (${env.nodeEnv})`);
  } else {
    console.log(`SmartStay API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  }
  try {
    await testConnection();
    console.log(`MySQL connected (${env.db.database})`);
    startJobs();
  } catch (err) {
    console.error(`MySQL not connected: ${err.message}. Background jobs not started.`);
  }
});

server.on('error', (err) => {
  console.error(`SmartStay API could not listen on ${socketPath || `port ${env.port}`}: ${err.message}`);
  process.exit(1);
});

/**
 * Local development convenience: also accept connections on a second port (5000 <-> 6000).
 * Connections are handed to the same HTTP server, so REST, Socket.IO and live updates
 * behave exactly as on the main port. Disabled when listening on a UNIX socket.
 */
let companion = null;
if (!socketPath) {
  const companionPort = Number(env.port) === 5000 ? 6000 : 5000;
  companion = net.createServer((connection) => server.emit('connection', connection));
  companion
    .listen(companionPort, () => console.log(`SmartStay API also listening on http://localhost:${companionPort}`))
    .on('error', (err) => {
      console.warn(`Companion port ${companionPort} not available (${err.code || err.message}); continuing on port ${env.port} only`);
      companion = null;
    });
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  stopJobs();
  await closeSockets();
  if (companion) companion.close();
  if (socketPath) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Already removed.
    }
  }
  server.close(async () => {
    await db.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
