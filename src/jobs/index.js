import { env } from '../config/env.js';
import { withDbLock } from '../core/lock.js';
import { runDevicePoll } from './devicePoll.job.js';
import { runAdapterHealth } from './adapterHealth.job.js';
import { escalateOverdue } from '../modules/requests/requests.service.js';
import { tickRules } from '../modules/rules/rules.service.js';
import { importEnergyReadings } from '../modules/energy/energy.service.js';
import { markNoShows } from '../modules/stays/stays.service.js';
import { runGuestRetention } from '../modules/stays/guests.service.js';
import { retryFailedRevocations } from '../modules/keys/keys.service.js';
import { reconcileAll } from '../modules/pms/pms.service.js';

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
  every('device-poll', j.devicePollSeconds, runDevicePoll);
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
