import { env } from '../config/env.js';
import { withDbLock } from '../utils/dbLock.js';
import { pollDevices, runAdapterHealth } from '../services/adapters.service.js';
import { escalateOverdue } from '../services/requests.service.js';
import { tickRules } from '../services/rules.service.js';
import { importEnergyReadings } from '../services/energy.service.js';
import { markNoShows } from '../services/stays.service.js';
import { runGuestRetention } from '../services/guests.service.js';
import { retryFailedRevocations } from '../services/keys.service.js';
import { reconcileAll } from '../services/pms.service.js';

const timers = [];
const running = new Set();

/**
 * Runs fn every `seconds`. A job never overlaps itself in this process, and the
 * MySQL lock stops it running on two API servers at once.
 */
function every(name, seconds, fn) {
  const tick = async () => {
    if (running.has(name)) return;
    running.add(name);
    try {
      await withDbLock(`job:${name}`, fn);
    } catch (err) {
      console.error(`[job:${name}]`, err);
    } finally {
      running.delete(name);
    }
  };
  timers.push(setInterval(tick, seconds * 1000));
  setTimeout(tick, 2000);
}

export function startJobs() {
  if (!env.jobs.enabled) return;
  const j = env.jobs;
  every('device-poll', j.devicePollSeconds, pollDevices);
  every('escalation', j.escalationSeconds, () => escalateOverdue());
  every('adapter-health', j.adapterHealthSeconds, runAdapterHealth);
  every('rules', j.rulesTickSeconds, () => tickRules());
  every('energy-import', j.energyImportMinutes * 60, importEnergyReadings);
  every('stays-housekeeping', j.staysHousekeepingMinutes * 60, async () => {
    await markNoShows();
    await retryFailedRevocations();
    await runGuestRetention();
  });
  every('pms-reconcile', j.pmsReconcileMinutes * 60, reconcileAll);
  console.log('Background jobs started');
}

export function stopJobs() {
  while (timers.length) clearInterval(timers.pop());
}
