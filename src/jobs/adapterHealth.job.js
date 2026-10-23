import { db } from '../config/db.js';
import { adapterFor } from '../adapters/index.js';
import { bus, EVENTS } from '../core/events.js';
import { raiseAlert } from '../modules/alerts/alerts.service.js';

const DOWN_AFTER_FAILURES = 3;

/** Checks one adapter and records its health. Raises an alert when it goes down. */
export async function checkAdapterHealth(adapter) {
  let result;
  try {
    result = await adapterFor(adapter).healthCheck();
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  const failures = result.ok ? 0 : adapter.consecutive_failures + 1;
  const status = result.ok ? 'healthy' : failures >= DOWN_AFTER_FAILURES ? 'down' : 'degraded';
  const patch = { status, consecutive_failures: failures, latency_ms: result.latencyMs ?? null };
  if (result.ok) patch.last_success_at = new Date();
  else Object.assign(patch, { last_error_at: new Date(), last_error: String(result.error || 'Unknown error').slice(0, 500) });
  await db('adapters').where({ id: adapter.id }).update(patch);

  if (status !== adapter.status) {
    bus.publish(EVENTS.ADAPTER_HEALTH_CHANGED, { adapterId: adapter.id, name: adapter.name, from: adapter.status, to: status });
    if (status === 'down') {
      await raiseAlert({
        type: 'adapter_down',
        severity: 'critical',
        source: 'system',
        title: `Device API "${adapter.name}" is not responding`,
        message: patch.last_error,
        adapterId: adapter.id,
      });
    }
  }
  return status;
}

export async function runAdapterHealth() {
  const adapters = await db('adapters').where({ is_enabled: true });
  for (const a of adapters) await checkAdapterHealth(a);
  return adapters.length;
}
