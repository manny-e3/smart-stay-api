import { CronExpressionParser } from 'cron-parser';
import * as Rule from '../models/rule.model.js';
import * as Room from '../models/room.model.js';
import * as Stay from '../models/stay.model.js';
import * as Device from '../models/device.model.js';
import { recordAudit } from './audit.service.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { badRequest, notFound } from '../utils/errors.js';
import { adapterFor } from '../integrations/devices/index.js';
import { getSettings } from './settings.service.js';
import { ingestEvent } from './devices.service.js';
import { raiseAlert } from './alerts.service.js';
import { ruleInputSchema } from '../validators/rules.validator.js';

/** Rules (Release 2): schedules and vacancy (eco) rules. The rule format is described in validators/rules.validator.js. */

const toRule = (r) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  isEnabled: Boolean(r.is_enabled),
  cron: r.cron,
  target: r.target,
  conditions: r.conditions || {},
  actions: r.actions,
  lastRunAt: r.last_run_at,
  lastRunStatus: r.last_run_status,
  nextRunAt: r.type === 'schedule' && r.is_enabled && r.cron ? nextRun(r.cron) : null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r) => ({
  id: r.id,
  trigger: r.trigger,
  status: r.status,
  roomsMatched: r.rooms_matched,
  commandsSent: r.commands_sent,
  commandsFailed: r.commands_failed,
  details: r.details,
  triggeredBy: r.triggered_by,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

function nextRun(cron) {
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(), tz: 'UTC' }).next().toDate();
  } catch {
    return null;
  }
}

async function checkSetpoints(actions) {
  const s = await getSettings();
  for (const a of actions) {
    if (a.type === 'set_climate' && a.setpoint !== undefined && (a.setpoint < s.ac_min_temp || a.setpoint > s.ac_max_temp)) {
      throw badRequest(`Setpoint ${a.setpoint} is outside the hotel AC range ${s.ac_min_temp}-${s.ac_max_temp}`);
    }
  }
}

/* ---- Managing rules -------------------------------------------------------------- */

export async function listRules(filters) {
  return (await Rule.list(filters)).map(toRule);
}

export async function getRule(id) {
  const r = await Rule.findById(id);
  if (!r) throw notFound('Rule');
  const runs = await Rule.recentRuns(id);
  return { ...toRule(r), recentRuns: runs.map(toRun) };
}

export async function listRuns(ruleId, paging) {
  await getRule(ruleId);
  const result = await Rule.listRuns(ruleId, paging);
  return { ...result, items: result.items.map(toRun) };
}

export async function createRule(input, actor) {
  await checkSetpoints(input.actions);
  const id = await Rule.create({
    name: input.name, type: input.type, is_enabled: input.isEnabled, cron: input.type === 'schedule' ? input.cron : null,
    target: input.target, conditions: input.conditions, actions: input.actions, created_by: actor.id,
  });
  await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'rule.create', entityType: 'rule', entityId: id, details: input, ip: actor.ip });
  return getRule(id);
}

export async function updateRule(id, patch, actor) {
  const current = await Rule.findById(id);
  if (!current) throw notFound('Rule');
  const merged = {
    name: current.name, type: current.type, isEnabled: Boolean(current.is_enabled), cron: current.cron ?? undefined,
    target: current.target, conditions: current.conditions || {}, actions: current.actions, ...patch,
  };
  const parsed = ruleInputSchema.safeParse(merged);
  if (!parsed.success) throw badRequest('Validation failed', parsed.error.issues.map((i) => ({ field: `body.${i.path.join('.')}`, message: i.message })));
  const r = parsed.data;
  await checkSetpoints(r.actions);
  await Rule.update(id, {
    name: r.name, type: r.type, is_enabled: r.isEnabled, cron: r.type === 'schedule' ? r.cron : null,
    target: r.target, conditions: r.conditions, actions: r.actions,
  });
  const onlyToggle = Object.keys(patch).length === 1;
  const action = patch.isEnabled === false && onlyToggle ? 'rule.disable' : patch.isEnabled === true && onlyToggle ? 'rule.enable' : 'rule.update';
  await recordAudit({ actor: { type: 'staff', id: actor.id }, action, entityType: 'rule', entityId: id, details: patch, ip: actor.ip });
  return getRule(id);
}

/* ---- Running rules ---------------------------------------------------------------- */

/** Rooms that have been empty for at least delayMinutes, by the rule's vacancy trigger. */
async function vacantRooms(rooms, trigger, delayMinutes, now) {
  const ids = rooms.map((r) => r.id);
  if (!ids.length) return [];
  const cutoff = new Date(now.getTime() - delayMinutes * 60_000);

  if (trigger === 'unsold') {
    const occupied = await Stay.occupiedRoomIds(ids);
    const lastBy = new Map((await Stay.lastCheckoutByRoom(ids)).map((r) => [r.room_id, new Date(r.at)]));
    return rooms.filter((r) => !occupied.has(r.id) && (!lastBy.has(r.id) || lastBy.get(r.id) <= cutoff));
  }

  // no_presence: every presence sensor in the room reports nobody since before the cutoff
  const byRoom = new Map();
  for (const s of await Device.presenceSensorStates(ids)) {
    if (s.state?.presence === undefined) continue;
    const list = byRoom.get(s.room_id) || [];
    list.push(s.state);
    byRoom.set(s.room_id, list);
  }
  return rooms.filter((r) => {
    const states = byRoom.get(r.id);
    return states?.length && states.every((st) => st.presence === false && st.presenceChangedAt && new Date(st.presenceChangedAt) <= cutoff);
  });
}

const DEVICE_FOR_ACTION = { set_climate: 'thermostat', lights: 'light', curtains: 'curtain' };

function commandFor(action, settings) {
  if (action.type === 'set_climate') {
    let setpoint = action.setpoint ?? (action.mode === 'eco' ? settings.eco_setpoint : undefined);
    if (setpoint !== undefined) setpoint = Math.min(settings.ac_max_temp, Math.max(settings.ac_min_temp, setpoint));
    return { action: 'set_climate', mode: action.mode, ...(setpoint !== undefined ? { setpoint } : {}) };
  }
  if (action.type === 'lights') return { action: 'set_power', on: action.on };
  return { action: 'set_curtain', open: action.open };
}

/** True when the device already is in the commanded state, so vacancy rules don't resend every minute. */
function alreadyApplied(state, command) {
  if (!state) return false;
  const { action, ...wanted } = command; // eslint-disable-line no-unused-vars
  return Object.entries(wanted).every(([k, v]) => state[k] === v);
}

export async function runRule(rule, trigger, { now = new Date(), staffId = null } = {}) {
  const settings = await getSettings();
  const conditions = rule.conditions || {};
  let rooms = await Room.listForTarget(rule.target);

  if (rule.type === 'schedule' && conditions.occupancy && conditions.occupancy !== 'any') {
    const occupied = await Stay.occupiedRoomIds(rooms.map((r) => r.id));
    rooms = rooms.filter((r) => (conditions.occupancy === 'occupied' ? occupied.has(r.id) : !occupied.has(r.id)));
  }
  if (rule.type === 'vacancy') {
    rooms = await vacantRooms(rooms, conditions.trigger, conditions.delayMinutes ?? settings.eco_delay_minutes, now);
  }

  const commands = [];
  if (rooms.length) {
    const types = [...new Set(rule.actions.map((a) => DEVICE_FOR_ACTION[a.type]))];
    const devices = await Device.inRoomsOfTypes(rooms.map((r) => r.id), types);
    for (const action of rule.actions) {
      const command = commandFor(action, settings);
      for (const d of devices.filter((x) => x.type === DEVICE_FOR_ACTION[action.type])) {
        if (trigger === 'vacancy' && alreadyApplied(d.state, command)) continue;
        // A guest who just changed the device wins over the vacancy rule until the delay has passed again.
        const delayMs = (conditions.delayMinutes ?? settings.eco_delay_minutes) * 60_000;
        if (trigger === 'vacancy' && d.state?.guestOverrideAt && now - new Date(d.state.guestOverrideAt) < delayMs) continue;
        commands.push({ device: d, command });
      }
    }
  }

  // Vacancy checks with nothing to do are not recorded, to keep run history readable.
  if (trigger === 'vacancy' && !commands.length) return null;

  const runId = await Rule.startRun({ ruleId: rule.id, trigger, roomsMatched: rooms.length, triggeredBy: staffId });

  let sent = 0;
  let failed = 0;
  const failures = [];
  for (const { device, command } of commands) {
    const adapterRow = { id: device.a_id, name: device.a_name, vendor: device.vendor, config: device.config, updated_at: device.a_updated_at };
    let result;
    try {
      result = await adapterFor(adapterRow).sendCommand(device, command);
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result.ok) {
      sent++;
      const newState = { ...(result.state ?? Object.fromEntries(Object.entries(command).filter(([k]) => k !== 'action'))) };
      // Remember when eco started and the mode to return to when the guest takes over.
      if (command.mode === 'eco' && device.state?.mode !== 'eco') {
        newState.ecoSince = now.toISOString();
        newState.modeBeforeEco = device.state?.mode ?? null;
      }
      await ingestEvent(device, { type: 'status', payload: { online: true, state: newState } });
    } else {
      failed++;
      failures.push({ deviceId: device.id, roomId: device.room_id, error: result.error });
      await raiseAlert({ type: 'command_failed', severity: 'warning', source: 'system', title: `Rule "${rule.name}" could not control ${device.name || device.type}`, message: result.error, roomId: device.room_id, deviceId: device.id, payload: { ruleId: rule.id, command } });
    }
  }

  const status = !commands.length ? 'skipped' : failed === 0 ? 'success' : sent === 0 ? 'failed' : 'partial';
  await Rule.finishRun(runId, { status, sent, failed, details: { rooms: rooms.slice(0, 200).map((r) => r.number), failures: failures.slice(0, 50) } });
  await Rule.update(rule.id, { last_run_at: now, last_run_status: status });
  const run = toRun(await Rule.findRun(runId));
  bus.publish(EVENTS.RULE_RUN, { ruleId: rule.id, run });
  return run;
}

export async function runRuleNow(id, actor) {
  const rule = await Rule.findById(id);
  if (!rule) throw notFound('Rule');
  const run = await runRule(rule, 'manual', { staffId: actor.id });
  await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'rule.run', entityType: 'rule', entityId: id, details: { runId: run?.id, status: run?.status }, ip: actor.ip });
  return run;
}

/** Background job, every minute: runs due schedule rules and checks vacancy rules. */
export async function tickRules(now = new Date()) {
  const settings = await getSettings();
  const runs = [];
  for (const rule of await Rule.listEnabled()) {
    try {
      if (rule.type === 'schedule') {
        const prev = CronExpressionParser.parse(rule.cron, { currentDate: now, tz: 'UTC' }).prev().toDate();
        const since = rule.last_run_at ? new Date(rule.last_run_at) : new Date(rule.created_at);
        // Run a missed slot only if it is recent, so a long outage doesn't replay old schedules.
        if (prev > since && now - prev < 10 * 60_000) runs.push(await runRule(rule, 'schedule', { now }));
      } else if (settings.eco_enabled) {
        const run = await runRule(rule, 'vacancy', { now });
        if (run) runs.push(run);
      }
    } catch (err) {
      console.error(`[rules] rule ${rule.id} failed:`, err);
      await Rule.update(rule.id, { last_run_at: now, last_run_status: 'failed' });
    }
  }
  return runs;
}
