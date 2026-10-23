/**
 * Contract every client device API adapter implements.
 * `devices` arguments are rows from the devices table: { id, external_id, type, room_id, ... }.
 */
export class BaseAdapter {
  constructor(row) {
    this.row = row;
    this.config = row.config || {};
  }

  /** @returns {Promise<{ ok: boolean, latencyMs?: number, error?: string }>} */
  async healthCheck() {
    throw new Error('healthCheck not implemented');
  }

  /**
   * Current state of each device.
   * @returns {Promise<Array<{ externalId: string, online: boolean, state: object }>>}
   */
  async fetchStates(devices) { // eslint-disable-line no-unused-vars
    return [];
  }

  /**
   * Sends a command, e.g. { action: 'set_climate', mode: 'eco', setpoint: 26 }.
   * @returns {Promise<{ ok: boolean, state?: object, error?: string }>}
   */
  async sendCommand(device, command) { // eslint-disable-line no-unused-vars
    return { ok: false, error: 'Commands not supported by this adapter' };
  }

  /**
   * Energy readings for metered devices since a date, one row per device per hour.
   * @returns {Promise<Array<{ externalId: string, periodStart: Date, kwh: number }>>}
   */
  async fetchEnergyReadings(devices, since) { // eslint-disable-line no-unused-vars
    return [];
  }

  /* ---- Digital keys (door locks) ------------------------------------- */

  /**
   * Issues a mobile key for a guest on a lock.
   * `credential` is whatever the vendor's mobile SDK needs; it is stored encrypted and handed to the guest app.
   * @returns {Promise<{ ok: boolean, externalKeyId?: string, credential?: object, error?: string }>}
   */
  async issueKey(device, { stayId, guestName, validFrom, validUntil }) { // eslint-disable-line no-unused-vars
    return { ok: false, error: 'Digital keys are not supported by this adapter' };
  }

  /** Changes a key's end time (stay extended). @returns {Promise<{ ok: boolean, error?: string }>} */
  async updateKey(device, externalKeyId, { validUntil }) { // eslint-disable-line no-unused-vars
    return { ok: false, error: 'Updating keys is not supported by this adapter' };
  }

  /** Revokes a key so it no longer opens the door. @returns {Promise<{ ok: boolean, error?: string }>} */
  async revokeKey(device, externalKeyId) { // eslint-disable-line no-unused-vars
    return { ok: false, error: 'Revoking keys is not supported by this adapter' };
  }

  /** Whether this vendor can open a lock from the cloud (the web app's only unlock method). */
  supportsRemoteUnlock() {
    return false;
  }

  /** Opens the lock remotely using the guest's key. @returns {Promise<{ ok: boolean, error?: string }>} */
  async unlock(device, { externalKeyId }) { // eslint-disable-line no-unused-vars
    return { ok: false, error: 'Remote unlock is not supported by this adapter' };
  }
}
