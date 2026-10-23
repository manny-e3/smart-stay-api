/**
 * PMS (property management system) adapters. Each vendor adapter turns the vendor's
 * reservations into the normalised shape below; everything else is vendor-neutral.
 *
 * Normalised reservation:
 *   { externalId, reference?, status: 'reserved'|'checked_in'|'checked_out'|'cancelled'|'no_show',
 *     roomCode?, roomType?, arrival, departure, adults?, children?, notes?,
 *     guest: { externalId?, firstName, lastName?, email?, phone?, language? }, companions?: [guest] }
 */

export class BasePms {
  constructor(row) {
    this.row = row;
    this.config = row.config || {};
  }

  /** @returns {Promise<{ ok: boolean, error?: string }>} */
  async healthCheck() {
    return { ok: true };
  }

  /** Every reservation currently checked in, used by reconciliation. */
  async fetchInHouse() {
    return [];
  }
}

/** In-memory PMS for development and tests. */
const inHouse = new Map();
export class MockPms extends BasePms {
  async healthCheck() {
    return this.config.simulateDown ? { ok: false, error: 'Simulated outage' } : { ok: true };
  }

  async fetchInHouse() {
    if (this.config.simulateDown) throw new Error('Simulated outage');
    return inHouse.get(this.row.id) ?? [];
  }

  static setInHouse(connectionId, reservations) {
    inHouse.set(connectionId, reservations);
  }

  static reset() {
    inHouse.clear();
  }
}

/**
 * Generic JSON-over-HTTP PMS, for a vendor API or a small bridge service:
 *   GET {baseUrl}{paths.health}   -> 2xx
 *   GET {baseUrl}{paths.inHouse}  -> [normalised reservation]
 * Real-time changes arrive on the webhook: POST /integrations/pms/{id}/events
 */
export class HttpPms extends BasePms {
  get paths() {
    return { health: '/health', inHouse: '/reservations/in-house', ...(this.config.paths || {}) };
  }

  async call(path) {
    if (!this.config.baseUrl) throw new Error('PMS baseUrl is not configured');
    const res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
      signal: AbortSignal.timeout(this.config.timeoutMs || 10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    return res.json();
  }

  async healthCheck() {
    try {
      await this.call(this.paths.health);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async fetchInHouse() {
    const data = await this.call(this.paths.inHouse);
    return Array.isArray(data) ? data : [];
  }
}

export const PMS_VENDORS = { mock: MockPms, http: HttpPms };

export function pmsFor(row) {
  const Impl = PMS_VENDORS[row.vendor];
  if (!Impl) throw new Error(`Unknown PMS vendor "${row.vendor}"`);
  return new Impl(row);
}
