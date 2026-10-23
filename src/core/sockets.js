import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { resolveAccessToken } from './auth.js';
import { rolesFor } from './permissions.js';
import { resolveGuestToken } from '../modules/guest/guest.auth.js';

let io = null;

/**
 * Socket.IO server for live dashboard updates.
 * Clients connect with { auth: { token: <access token> } }.
 * Each socket joins "staff:<id>" and "role:<role>" rooms; events are sent to the roles allowed to see them.
 */
export function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins.includes('*') ? true : env.corsOrigins, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers.authorization?.replace(/^Bearer /, '');
      if (!token) return next(new Error('Authentication required'));
      socket.data.staff = await resolveAccessToken(token);
      next();
    } catch (err) {
      next(new Error(err.message || 'Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role } = socket.data.staff;
    socket.join([`staff:${id}`, `role:${role}`]);
    socket.emit('ready', { staffId: id, role });
  });

  // Guest app channel: io(url + '/guest', { auth: { token: guestToken } }). One room per stay.
  const guests = io.of('/guest');
  guests.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers.authorization?.replace(/^Bearer /, '');
      if (!token) return next(new Error('Authentication required'));
      socket.data.guest = await resolveGuestToken(token);
      next();
    } catch (err) {
      next(new Error(err.message || 'Authentication failed'));
    }
  });
  guests.on('connection', (socket) => {
    socket.join(`stay:${socket.data.guest.stayId}`);
    socket.emit('ready', { roomNumber: socket.data.guest.roomNumber });
  });

  return io;
}

export function emitToStay(stayId, event, payload) {
  if (io) io.of('/guest').to(`stay:${stayId}`).emit(event, payload);
}

/** Signs out guest app sockets of a stay (check-out, access reset). */
export function disconnectStay(stayId) {
  if (io) io.of('/guest').in(`stay:${stayId}`).disconnectSockets(true);
}

export const getIo = () => io;

/** Emits to every connected staff member whose role has the permission. */
export function emitToPermission(permission, event, payload) {
  if (!io) return;
  const rooms = rolesFor(permission).map((r) => `role:${r}`);
  if (rooms.length) io.to(rooms).emit(event, payload);
}

export function emitToRoles(roles, event, payload) {
  if (io && roles.length) io.to(roles.map((r) => `role:${r}`)).emit(event, payload);
}

export function emitToStaff(staffId, event, payload) {
  if (io) io.to(`staff:${staffId}`).emit(event, payload);
}

/** Disconnects all sockets of a staff member, used when they are deactivated. */
export async function disconnectStaff(staffId) {
  if (io) io.in(`staff:${staffId}`).disconnectSockets(true);
}

export async function closeSockets() {
  if (io) await io.close();
  io = null;
}
