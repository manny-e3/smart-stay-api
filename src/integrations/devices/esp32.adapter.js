import { BaseAdapter } from './base.adapter.js';

/**
 * Dedicated ESP32 In-Room Hub Adapter for SmartStay.
 * Communicates with the ESP32's onboard HTTP REST server or receives push telemetry.
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

    const base = devConfig?.ip || caps?.ip || this.config.baseUrl;
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

  async sendCommand(device, command) {
    try {
      const url = this.getUrl(device, '/devices/command');
      if (!url) {
        return {
          ok: false,
          error: `ESP32 IP address not configured for device "${device.name || device.external_id}". Set device capabilities.ip or adapter baseUrl.`,
        };
      }
      const payload = {
        externalId: device.external_id,
        command,
      };
      const res = await this.call(url, 'POST', payload);
      return { ok: res?.ok !== false, state: res?.state, error: res?.error };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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
