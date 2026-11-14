/**
 * Commands waiting for ESP32 room hubs. Hubs can't be reached from the internet (they sit behind
 * the hotel or MiFi network), so the API never connects to them. Instead each hub collects its
 * room's commands when it polls GET /integrations/esp32/rooms/:room/commands (every 1.5 s) or posts
 * telemetry. Every path that switches a relay (dashboard, guest app, voice, rules) ends up here.
 *
 * Kept in memory: commands not collected before an API restart are lost, and the API must run as
 * a single instance. Moving to MQTT removes both limits.
 */

const MAX_QUEUED_PER_ROOM = 20;

// When a relay was toggled, telemetry that was already on its way (built before the hub received
// the command) still carries the OLD relay state and would flip the tile back. Relay states
// reported within this window after a command are ignored for that relay.
const COMMAND_SETTLE_MS = 10000;

const queue = new Map(); // roomNumber -> [{ id, device, deviceKey, state, createdAt }]
const recentCommands = new Map(); // `${room}:${relay}` -> time of the last command (ms)

const roomKey = (roomNumber) => String(roomNumber).replace(/Room\s*/i, '').trim();

/** The hub's name for a relay: light | ac | tv | fridge. light1-4 are the old channel names. */
export function canonicalRelay(key) {
  const k = String(key || '').toLowerCase().replace(/-/g, '');
  if (k === 'light' || k === 'light1') return 'light';
  if (k === 'ac' || k === 'light2') return 'ac';
  if (k === 'tv' || k === 'light3') return 'tv';
  if (k === 'fridge' || k === 'light4') return 'fridge';
  return k;
}

export const RELAYS = ['light', 'ac', 'tv', 'fridge'];

export function isRelaySettling(roomNumber, relay) {
  const t = recentCommands.get(`${roomKey(roomNumber)}:${canonicalRelay(relay)}`);
  return t !== undefined && Date.now() - t < COMMAND_SETTLE_MS;
}

/** Queues "switch this relay on/off" for the room's hub. */
export function enqueueCommand(roomNumber, deviceKey, state) {
  const room = roomKey(roomNumber);
  recentCommands.set(`${room}:${canonicalRelay(deviceKey)}`, Date.now());
  if (!queue.has(room)) queue.set(room, []);
  const cmd = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    device: deviceKey,
    deviceKey,
    state: Boolean(state),
    createdAt: new Date().toISOString(),
  };
  const list = queue.get(room);
  list.push(cmd);
  if (list.length > MAX_QUEUED_PER_ROOM) list.shift();
  return cmd;
}

/** Hands the room's waiting commands to the hub and clears them. */
export function popCommands(roomNumber) {
  const room = roomKey(roomNumber);
  const list = queue.get(room) || [];
  queue.set(room, []);
  return list;
}
