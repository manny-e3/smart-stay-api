import { randomUUID } from 'node:crypto';
import { BaseAdapter } from './base.js';
import { db } from '../config/db.js';

/**
 * In-memory adapter for development, tests and demos before the client's vendor APIs are available.
 * config: { simulateDown?: boolean, failCommands?: boolean }
 */
const stores = new Map();
const keyStores = new Map();

export class MockAdapter extends BaseAdapter {
  get store() {
    if (!stores.has(this.row.id)) stores.set(this.row.id, new Map());
    return stores.get(this.row.id);
  }

  async healthCheck() {
    if (this.config.simulateDown) return { ok: false, latencyMs: 0, error: 'Simulated outage' };
    return { ok: true, latencyMs: 1 };
  }

  async fetchStates(devices) {
    if (this.config.simulateDown) throw new Error('Simulated outage');
    return devices
      .filter((d) => this.store.has(d.external_id))
      .map((d) => ({ externalId: d.external_id, ...this.store.get(d.external_id) }));
  }

  async sendCommand(device, command) {
    if (this.config.simulateDown || this.config.failCommands) return { ok: false, error: 'Simulated failure' };
    const current = this.store.get(device.external_id) || { online: true, state: {} };
    const { action, ...rest } = command;
    const next = { online: true, state: { ...current.state, ...rest, lastAction: action } };
    this.store.set(device.external_id, next);
    return { ok: true, state: next.state };
  }

  /** Deterministic fake hourly readings so charts have data in development. */
  async fetchEnergyReadings(devices, since) {
    const out = [];
    const start = new Date(since);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date();
    end.setUTCMinutes(0, 0, 0);
    for (const d of devices.filter((x) => x.type === 'meter')) {
      for (let t = start.getTime(); t < end.getTime(); t += 3_600_000) {
        const hour = new Date(t).getUTCHours();
        const base = 0.3 + ((d.id * 7 + hour * 13) % 10) / 10;
        out.push({ externalId: d.external_id, periodStart: new Date(t), kwh: Number((base * (hour >= 18 || hour < 7 ? 1.6 : 1)).toFixed(4)) });
      }
    }
    return out;
  }

  /* ---- Digital keys: in-memory key store per adapter ------------------ */

  get keys() {
    if (!keyStores.has(this.row.id)) keyStores.set(this.row.id, new Map());
    return keyStores.get(this.row.id);
  }

  async issueKey(device, { stayId, validFrom, validUntil }) {
    if (this.config.simulateDown || this.config.failKeys) return { ok: false, error: 'Simulated key failure' };
    const externalKeyId = `mk_${randomUUID()}`;
    this.keys.set(externalKeyId, { lock: device.external_id, stayId, validFrom: new Date(validFrom), validUntil: new Date(validUntil), revoked: false });
    return { ok: true, externalKeyId, credential: { type: 'mock', keyId: externalKeyId, token: randomUUID() } };
  }

  async updateKey(device, externalKeyId, { validUntil }) {
    const key = this.keys.get(externalKeyId);
    if (!key || key.revoked) return { ok: false, error: 'Key not found' };
    key.validUntil = new Date(validUntil);
    return { ok: true };
  }

  async revokeKey(device, externalKeyId) {
    if (this.config.simulateDown || this.config.failRevoke) return { ok: false, error: 'Simulated revoke failure' };
    const key = this.keys.get(externalKeyId);
    if (key) key.revoked = true;
    return { ok: true };
  }

  supportsRemoteUnlock() {
    return this.config.remoteUnlock !== false;
  }

  async unlock(device, { externalKeyId }) {
    if (this.config.simulateDown) return { ok: false, error: 'Simulated outage' };
    const key = this.keys.get(externalKeyId);
    const now = new Date();
    if (key) {
      if (key.revoked || key.lock !== device.external_id || now < key.validFrom || now > key.validUntil) {
        return { ok: false, error: 'Key not valid for this door' };
      }
      return { ok: true };
    }
    // Fallback: check database if server restarted
    const dbKey = await db('digital_keys as k')
      .join('devices as d', 'd.id', 'k.device_id')
      .where({ 'k.external_key_id': externalKeyId, 'd.external_id': device.external_id })
      .first('k.*');
    if (!dbKey || dbKey.status !== 'active' || now < new Date(dbKey.valid_from) || now > new Date(dbKey.valid_until)) {
      return { ok: false, error: 'Key not valid for this door' };
    }
    this.keys.set(externalKeyId, { lock: device.external_id, stayId: dbKey.stay_id, validFrom: new Date(dbKey.valid_from), validUntil: new Date(dbKey.valid_until), revoked: false });
    return { ok: true };
  }

  /** Test helper: the mock lock's view of a key. */
  static getKey(adapterId, externalKeyId) {
    return keyStores.get(adapterId)?.get(externalKeyId) ?? null;
  }

  /** Test helper: set a device's state as if the vendor reported it. */
  static setState(adapterId, externalId, value) {
    if (!stores.has(adapterId)) stores.set(adapterId, new Map());
    stores.get(adapterId).set(externalId, value);
  }

  static reset() {
    stores.clear();
    keyStores.clear();
  }
}
