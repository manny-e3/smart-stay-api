import { BaseAdapter } from './base.js';

/**
 * Generic JSON-over-HTTP adapter. Point it at a vendor API or at a small bridge service
 * that translates the vendor's API into this contract:
 *
 *   GET  {baseUrl}{paths.health}                       -> 2xx when healthy
 *   POST {baseUrl}{paths.states}   { ids: [...] }      -> [{ externalId, online, state }]
 *   POST {baseUrl}{paths.command}  { externalId, command } -> { ok, state? }
 *   GET  {baseUrl}{paths.energy}?since=ISO&ids=a,b     -> [{ externalId, periodStart, kwh }]
 *   POST   {baseUrl}{paths.keys}  { externalId, stayId, guestName, validFrom, validUntil } -> { keyId, credential? }
 *   PATCH  {baseUrl}{paths.keys}/{keyId} { validUntil }  -> 2xx
 *   DELETE {baseUrl}{paths.keys}/{keyId}                 -> 2xx
 *   POST   {baseUrl}{paths.unlock} { externalId, keyId }  -> 2xx when the door opened
 *
 * config: { baseUrl, apiKey?, timeoutMs?, paths?: { health, states, command, energy, keys, unlock } }
 */
export class HttpAdapter extends BaseAdapter {
  get paths() {
    return { health: '/health', states: '/devices/states', command: '/devices/command', energy: '/energy', keys: '/keys', unlock: '/locks/unlock', ...(this.config.paths || {}) };
  }

  async call(method, path, body) {
    if (!this.config.baseUrl) throw new Error('Adapter baseUrl is not configured');
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.timeoutMs || 5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async healthCheck() {
    const started = Date.now();
    try {
      await this.call('GET', this.paths.health);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
  }

  async fetchStates(devices) {
    if (!devices.length) return [];
    const data = await this.call('POST', this.paths.states, { ids: devices.map((d) => d.external_id) });
    return Array.isArray(data) ? data : [];
  }

  async sendCommand(device, command) {
    try {
      const data = await this.call('POST', this.paths.command, { externalId: device.external_id, command });
      return { ok: data?.ok !== false, state: data?.state, error: data?.error };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async issueKey(device, { stayId, guestName, validFrom, validUntil }) {
    try {
      const data = await this.call('POST', this.paths.keys, { externalId: device.external_id, stayId, guestName, validFrom, validUntil });
      if (!data?.keyId) return { ok: false, error: 'Vendor did not return a key id' };
      return { ok: true, externalKeyId: String(data.keyId), credential: data.credential ?? null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async updateKey(device, externalKeyId, { validUntil }) {
    try {
      await this.call('PATCH', `${this.paths.keys}/${encodeURIComponent(externalKeyId)}`, { validUntil });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async revokeKey(device, externalKeyId) {
    try {
      await this.call('DELETE', `${this.paths.keys}/${encodeURIComponent(externalKeyId)}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  supportsRemoteUnlock() {
    return this.config.remoteUnlock !== false;
  }

  async unlock(device, { externalKeyId }) {
    try {
      await this.call('POST', this.paths.unlock, { externalId: device.external_id, keyId: externalKeyId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async fetchEnergyReadings(devices, since) {
    const meters = devices.filter((d) => d.type === 'meter');
    if (!meters.length) return [];
    const qs = new URLSearchParams({ since: new Date(since).toISOString(), ids: meters.map((d) => d.external_id).join(',') });
    const data = await this.call('GET', `${this.paths.energy}?${qs}`);
    return (Array.isArray(data) ? data : []).map((r) => ({ ...r, periodStart: new Date(r.periodStart) }));
  }
}
