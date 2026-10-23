import { db } from '../config/db.js';
import { adapterFor } from '../adapters/index.js';
import { applyPolledStates } from '../modules/devices/devices.service.js';

/**
 * Polls every enabled adapter for device states. Adapters that push events by
 * webhook can return nothing here. Adapters marked down are skipped until the
 * health job sees them recover.
 */
export async function runDevicePoll() {
  const adapters = await db('adapters').where({ is_enabled: true }).whereNot({ status: 'down' });
  let changed = 0;
  for (const adapter of adapters) {
    const devices = await db('devices').where({ adapter_id: adapter.id, is_active: true });
    if (!devices.length) continue;
    try {
      const states = await adapterFor(adapter).fetchStates(devices);
      changed += await applyPolledStates(adapter, devices, states);
    } catch (err) {
      console.error(`[poll] adapter ${adapter.name} failed:`, err.message);
    }
  }
  return changed;
}
