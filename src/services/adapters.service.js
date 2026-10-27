import crypto from 'node:crypto';
import * as Device from '../models/device.model.js';
import { adapterFor } from '../integrations/devices/index.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { sha256 } from '../utils/crypto.js';
import { notFound, unauthorized } from '../utils/errors.js';
import { raiseAlert } from './alerts.service.js';
import { applyPolledStates, ingestForAdapter } from './devices.service.js';

/** Device vendor connections ("adapters"): health checks, polling and incoming webhooks. */

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
  await Device.updateAdapter(adapter.id, patch);

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

/** Health check by adapter id (the "Check now" button). */
export async function checkAdapterHealthById(id) {
  const adapter = await Device.findAdapter(id);
  if (!adapter) throw notFound('Adapter');
  await checkAdapterHealth(adapter);
  return adapter.id;
}

/** Background job: check every enabled adapter. */
export async function runAdapterHealth() {
  const adapters = await Device.listEnabledAdapters();
  for (const a of adapters) await checkAdapterHealth(a);
  return adapters.length;
}

/**
 * Background job: ask every enabled adapter for device states. Adapters that push
 * events by webhook can return nothing. Adapters marked down are skipped.
 */
export async function pollDevices() {
  const adapters = await Device.listPollableAdapters();
  let changed = 0;
  for (const adapter of adapters) {
    const devices = await Device.listActiveForAdapter(adapter.id);
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

/**
 * Webhook from a device vendor: checks the X-Adapter-Secret header against the adapter's
 * stored secret hash, then feeds the events through the device pipeline.
 */
export async function receiveWebhook(adapterId, secret, events) {
  const adapter = await Device.findEnabledAdapter(adapterId);
  const ok = adapter?.webhook_secret_hash && crypto.timingSafeEqual(Buffer.from(sha256(secret || '')), Buffer.from(adapter.webhook_secret_hash));
  if (!ok) throw unauthorized('Invalid adapter credentials');
  const results = await ingestForAdapter(adapter.id, events);
  await Device.updateAdapter(adapter.id, { last_success_at: new Date() });
  return { accepted: results.filter((r) => r.accepted).length, results };
}
