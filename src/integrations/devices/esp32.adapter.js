import { BaseAdapter } from './base.adapter.js';
import { canonicalRelay, enqueueCommand, RELAYS } from './esp32.queue.js';
import * as Room from '../../models/room.model.js';

/**
 * On (true) or off (false) for a relay, from a SmartStay command such as
 * { action: 'set_light', on: true }, { action: 'set_climate', power: false } or { mode: 'off' }.
 * undefined when the command doesn't switch anything.
 */
/**
 * Whether the API can open a connection to a hub at this address: private LAN addresses only
 * (10.x, 172.16-31.x, 192.168.x). A public address is the hotel or MiFi router, and loopback
 * would hit this server's own machine.
 */
export function isReachableHubHost(base) {
  let host;
  try {
    host = new URL(String(base).trim()).hostname;
  } catch {
    return false;
  }
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = parts;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function relayStateFor(command = {}) {
  if (typeof command.on === 'boolean') return command.on;
  if (typeof command.power === 'boolean') return command.power;
  if (command.mode === 'off') return false;
  if (typeof command.brightness === 'number') return command.brightness > 0;
  return undefined;
}

/**
 * Dedicated ESP32 In-Room Hub Adapter for SmartStay.
 * Hubs push telemetry to /integrations/esp32/telemetry and poll for commands; sendCommand only
 * queues (see esp32.queue.js). The HTTP calls below (states, energy, health) are used only when
 * the API can reach the hub directly, e.g. both on the same LAN.
 *
 * Config schema in `adapters.config`:
 *   {
 *     "baseUrl": "http://192.168.1.100",  // Optional fallback/gateway IP
 *     "timeoutMs": 4000,
 *     "apiKey": "optional-secret"
 *   }
 */
export class Esp32Adapter extends BaseAdapter {
  getUrl(device, path) {
    let caps = device?.capabilities;
    if (typeof caps === 'string') {
      try { caps = JSON.parse(caps); } catch {}
    }
    let devConfig = device?.config;
    if (typeof devConfig === 'string') {
      try { devConfig = JSON.parse(devConfig); } catch {}
    }

    // An address learned from telemetry is used only when it is on the LAN (older versions saved
    // the router's public address, which never answers). An adapter baseUrl set by hand is trusted.
    const learned = [devConfig?.ip, caps?.ip].find((ip) => ip && isReachableHubHost(ip));
    const base = learned || this.config.baseUrl;
    if (!base) return null;

    // Disallow bare localhost/127.0.0.1 without port to prevent accidentally hitting
    // local web servers like Apache or IIS that return HTML dashboards
    const trimmed = String(base).trim();
    if (
      trimmed === 'http://127.0.0.1' ||
      trimmed === 'http://localhost' ||
      trimmed === 'http://127.0.0.1:80' ||
      trimmed === 'http://localhost:80'
    ) {
      return null;
    }

    return `${trimmed.replace(/\/$/, '')}${path}`;
  }

  async call(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.timeoutMs || 4000),
    });

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`ESP32 responded with HTTP ${res.status}`);
    }

    if (!text || text.trim() === '') return null;

    if (!contentType.includes('application/json') && text.trim().startsWith('<')) {
      throw new Error(`Expected JSON from ESP32 at ${url}, but received HTML (HTTP ${res.status})`);
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse ESP32 JSON response from ${url}: ${err.message}`);
    }
  }

  async healthCheck() {
    const started = Date.now();
    const base = this.config.baseUrl?.trim();

    // If a custom non-default baseUrl is configured, ping its /health endpoint
    if (
      base &&
      base !== 'http://127.0.0.1' &&
      base !== 'http://localhost' &&
      base !== 'http://127.0.0.1:80' &&
      base !== 'http://localhost:80'
    ) {
      try {
        const url = `${base.replace(/\/$/, '')}/health`;
        const data = await this.call(url, 'GET');
        return { ok: Boolean(data?.ok), latencyMs: Date.now() - started };
      } catch (err) {
        return { ok: false, latencyMs: Date.now() - started, error: err.message };
      }
    }

    // In push-telemetry mode or when devices manage their own IPs,
    // the receiver adapter is healthy.
    return { ok: true, latencyMs: Date.now() - started };
  }

  async fetchStates(devices) {
    if (!devices?.length) return [];

    // Group devices by target hub URL (each room's ESP32 has its own IP)
    const byUrl = new Map();
    for (const dev of devices) {
      const url = this.getUrl(dev, '/devices/states');
      if (!url) continue; // Push-based device or no IP configured yet
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(dev);
    }

    // If no devices have an active HTTP REST target configured, they are push-only
    if (byUrl.size === 0) return [];

    const results = [];
    for (const [url, devs] of byUrl) {
      try {
        const data = await this.call(url, 'POST', { ids: devs.map((d) => d.external_id) });
        if (Array.isArray(data)) results.push(...data);
      } catch (err) {
        console.warn(`[Esp32Adapter] fetchStates from ${url} failed: ${err.message}`);
      }
    }
    return results;
  }

  /**
   * Queues the command for the room's hub, which collects it on its next poll (about 1.5 s).
   * The API never connects to the hub: it is behind the hotel or MiFi network and can't be
   * reached from the server. The hub's relays only switch on and off, so commands that don't
   * say on or off (a new setpoint, eco mode) leave the relay as it is.
   */
  async sendCommand(device, command) {
    const roomNumber = device.room_id ? (await Room.findNumber(device.room_id))?.number : null;
    if (!roomNumber) return { ok: false, error: `"${device.name || device.external_id}" is not assigned to a room` };

    // Device ids are "<relay>-<room>", e.g. "ac-106" or "light-2-106" (old channel names).
    const ext = String(device.external_id || '');
    const suffix = `-${roomNumber}`;
    const relay = canonicalRelay(ext.endsWith(suffix) ? ext.slice(0, -suffix.length) : ext);
    if (!RELAYS.includes(relay)) return { ok: false, error: `"${device.name || ext}" is not a relay on the room hub` };

    const on = relayStateFor(command);
    if (on === undefined) return { ok: true };
    enqueueCommand(roomNumber, relay, on);
    return { ok: true, state: device.type === 'thermostat' ? { power: on, on } : { on } };
  }

  async fetchEnergyReadings(devices, since) {
    const meters = (devices || []).filter((d) => d.type === 'meter');
    if (!meters.length) return [];

    const byUrl = new Map();
    for (const meter of meters) {
      const url = this.getUrl(meter, '/energy');
      if (!url) continue;
      if (!byUrl.has(url)) byUrl.set(url, meter);
    }

    // If no meters have an HTTP IP configured, energy telemetry is streamed via push
    if (byUrl.size === 0) return [];

    const results = [];
    for (const [url, meter] of byUrl) {
      try {
        const data = await this.call(url, 'GET');
        if (Array.isArray(data)) {
          for (const r of data) {
            results.push({
              externalId: r.externalId || meter.external_id,
              periodStart: new Date(r.periodStart || new Date()),
              kwh: Number(r.kwh || 0),
            });
          }
        }
      } catch (err) {
        console.warn(`[Esp32Adapter] fetchEnergyReadings from ${url} failed: ${err.message}`);
      }
    }
    return results;
  }
}
