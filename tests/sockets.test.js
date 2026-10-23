import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as connect } from 'socket.io-client';
import { app, resetDb, tokenFor, seedHotel, as } from './helpers.js';
import { db } from '../src/config/db.js';
import { initSockets, closeSockets } from '../src/core/sockets.js';
import { registerListeners } from '../src/core/listeners.js';

let server;
let url;
let hotel;

beforeAll(async () => {
  await resetDb();
  hotel = await seedHotel();
  server = http.createServer(app);
  initSockets(server);
  registerListeners();
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await closeSockets();
  await new Promise((r) => server.close(r));
  await db.destroy();
});

const open = (token) =>
  new Promise((resolve, reject) => {
    const s = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('ready', () => resolve(s));
    s.on('connect_error', (err) => {
      s.close();
      reject(err);
    });
  });

const next = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

describe('live updates', () => {
  it('refuses connections without a valid token', async () => {
    await expect(open('nope')).rejects.toThrow();
  });

  it('pushes new requests to the queue and room changes to the board within 5 s', async () => {
    const serviceSocket = await open(await tokenFor('service'));
    const maintSocket = await open(await tokenFor('maintenance'));
    let maintGotRequest = false;
    maintSocket.on('request:created', () => (maintGotRequest = true));

    const started = Date.now();
    const created = next(serviceSocket, 'request:created');
    const roomUpdate = next(maintSocket, 'board:room');
    await (await as('manager')).post('/admin/requests').send({ roomId: hotel.rooms[0].id, category: 'food' });

    expect((await created).room.number).toBe('101');
    const summary = await roomUpdate;
    expect(summary).toMatchObject({ number: '101', status: 'request' });
    expect(Date.now() - started).toBeLessThan(5000);
    // Maintenance can see the board but not the request queue
    expect(maintGotRequest).toBe(false);

    serviceSocket.close();
    maintSocket.close();
  });
});
