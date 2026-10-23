import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { db, paginate, json } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { bus, EVENTS } from '../../core/events.js';
import { badRequest, notFound } from '../../core/errors.js';
import { adapterFor } from '../../adapters/index.js';
import { getSettings } from '../settings/settings.service.js';
import { ingestEvent } from '../devices/devices.service.js';
import { raiseAlert } from '../alerts/alerts.service.js';

/**
 * Rules (Release 2).
 *  schedule: runs at a cron time, e.g. "0 23 * * *" = every day at 23:00 (server time, UTC).
 *  vacancy:  checked every minute; acts on rooms that have been empty longer than the delay.
 *
 * target:     { scope: 'all' } | { scope: 'floors', floors: [1,2] } | { scope: 'rooms', roomIds: [..] } | { scope: 'roomTypes', roomTypes: ['Suite'] }
 * conditions: schedule -> { occupancy: 'any' | 'vacant' | 'occupied' }
 *             vacancy  -> { trigger: 'unsold' | 'no_presence', delayMinutes?: number }  (delay defaults to eco delay setting)
 * actions:    [{ type: 'set_climate', mode: 'eco'|'cool'|'heat'|'auto'|'off', setpoint?: number },
 *              { type: 'lights', on: boolean }, { type: 'curtains', open: boolean }]
 */

const targetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }),
  z.object({ scope: z.literal('floors'), floors: z.array(z.number().int()).min(1) }),
  z.object({ scope: z.literal('rooms'), roomIds: z.array(z.number().int().positive()).min(1) }),
  z.object({ scope: z.literal('roomTypes'), roomTypes: z.array(z.string().min(1)).min(1) }),
]);

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_climate'), mode: z.enum(['eco', 'cool', 'heat', 'auto', 'off']), setpoint: z.number().min(10).max(35).optional() }),
  z.object({ type: z.literal('lights'), on: z.boolean() }),
  z.object({ type: z.literal('curtains'), open: z.boolean() }),
]);

export const ruleInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    type: z.enum(['schedule', 'vacancy']),
    isEnabled: z.boolean().default(true),
    cron: z.string().trim().max(120).optional(),
    target: targetSchema,
    conditions: z
      .object({
        occupancy: z.enum(['any', 'vacant', 'occupied']).optional(),
        trigger: z.enum(['unsold', 'no_presence']).optional(),
        delayMinutes: z.number().int().min(1).max(1440).optional(),
      })
      .default({}),
    actions: z.array(actionSchema).min(1).max(10),
  })
  .superRefine((r, ctx) => {
    if (r.type === 'schedule') {
      if (!r.cron) ctx.addIssue({ code: 'custom', path: ['cron'], message: 'A cron schedule is required for schedule rules' });
      else {
        try {
          CronExpressionParser.parse(r.cron);
        } catch {
          ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Invalid cron expression' });
        }
      }
    }
    if (r.type === 'vacancy' && !r.conditions.trigger) {
      ctx.addIssue({ code: 'custom', path: ['conditions', 'trigger'], message: 'Vacancy rules need a trigger: unsold or no_presence' });
    }
  });

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

export async function listRules({ type, enabled }) {
  const q = db('rules').orderBy('name');
  if (type) q.where({ type });
  if (enabled !== undefined) q.where({ is_enabled: enabled });
  return (await q).map(toRule);
}

export async function getRule(id) {
  const r = await db('rules').where({ id }).first();
  if (!r) throw notFound('Rule');
  const runs = await db('rule_runs').where({ rule_id: id }).orderBy('started_at', 'desc').limit(20);
  return { ...toRule(r), recentRuns: runs.map(toRun) };
}

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

export async function listRuns(ruleId, { page, limit }) {
  const result = await paginate(db('rule_runs').where({ rule_id: ruleId }).orderBy('started_at', 'desc'), { page, limit });
  return { ...result, items: result.items.map(toRun) };
}

export async function createRule(input, actor) {
  await checkSetpoints(input.actions);
  const [id] = await db('rules').insert({
    name: input.name, type: input.type, is_enabled: input.isEnabled, cron: input.type === 'schedule' ? input.cron : null,
    target: json(input.target), conditions: json(input.conditions), actions: json(input.actions), created_by: actor.id,
  });
  await audit({ actor: { type: 'staff', id: actor.id }, action: 'rule.create', entityType: 'rule', entityId: id, details: input, ip: actor.ip });
  return getRule(id);
}

export async function updateRule(id, patch, actor) {
  const current = await db('rules').where({ id }).first();
  if (!current) throw notFound('Rule');
  const merged = {
    name: current.name, type: current.type, isEnabled: Boolean(current.is_enabled), cron: current.cron ?? undefined,
    target: current.target, conditions: current.conditions || {}, actions: current.actions, ...patch,
  };
  const parsed = ruleInputSchema.safeParse(merged);
  if (!parsed.success) throw badRequest('Validation failed', parsed.error.issues.map((i) => ({ field: `body.${i.path.join('.')}`, message: i.message })));
  const r = parsed.data;
  await checkSetpoints(r.actions);
  await db('rules').where({ id }).update({
    name: r.name, type: r.type, is_enabled: r.isEnabled, cron: r.type === 'schedule' ? r.cron : null,
    target: json(r.target), conditions: json(r.conditions), actions: json(r.actions),
  });
  const action = patch.isEnabled === false && Object.keys(patch).length === 1 ? 'rule.disable' : patch.isEnabled === true && Object.keys(patch).length === 1 ? 'rule.enable' : 'rule.update';
  await audit({ actor: { type: 'staff', id: actor.id }, action, entityType: 'rule', entityId: id, details: patch, ip: actor.ip });
  return getRule(id);
}

/* ------------------------------------------------------------------ runner */

async function targetRooms(target) {
  const q = db('rooms as r').leftJoin('room_types as t', 't.id', 'r.room_type_id').join('floors as f', 'f.id', 'r.floor_id').where('r.is_active', true).select('r.id', 'r.number');
  if (target.scope === 'floors') q.whereIn('f.number', target.floors);
  if (target.scope === 'rooms') q.whereIn('r.id', target.roomIds);
  if (target.scope === 'roomTypes') q.whereIn('t.name', target.roomTypes);
  return q;
}

async function occupiedRoomIds(roomIds) {
  if (!roomIds.length) return new Set();
  const rows = await db('stays').whereIn('room_id', roomIds).where('status', 'checked_in').distinct('room_id');
  return new Set(rows.map((r) => r.room_id));
}

/** Rooms that have been empty for at least delayMinutes, by the rule's vacancy trigger. */
async function vacantRooms(rooms, trigger, delayMinutes, now) {
  const ids = rooms.map((r) => r.id);
  if (!ids.length) return [];
  const cutoff = new Date(now.getTime() - delayMinutes * 60_000);

  if (trigger === 'unsold') {
    const occupied = await occupiedRoomIds(ids);
    const lastCheckout = await db('stays')
      .whereIn('room_id', ids)
      .where('status', 'checked_out')
      .groupBy('room_id')
      .select('room_id')
      .select(db.raw('MAX(COALESCE(checked_out_at, updated_at)) AS at'));
    const lastBy = new Map(lastCheckout.map((r) => [r.room_id, new Date(r.at)]));
    return rooms.filter((r) => !occupied.has(r.id) && (!lastBy.has(r.id) || lastBy.get(r.id) <= cutoff));
  }

  // no_presence: every presence sensor in the room reports nobody since before the cutoff
  const sensors = await db('devices as d')
    .join('device_states as s', 's.device_id', 'd.id')
    .whereIn('d.room_id', ids)
    .where({ 'd.is_active': true, 'd.type': 'sensor' })
    .select('d.room_id', 's.state');
  const byRoom = new Map();
  for (const s of sensors) {
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
  let rooms = await targetRooms(rule.target);

  if (rule.type === 'schedule' && conditions.occupancy && conditions.occupancy !== 'any') {
    const occupied = await occupiedRoomIds(rooms.map((r) => r.id));
    rooms = rooms.filter((r) => (conditions.occupancy === 'occupied' ? occupied.has(r.id) : !occupied.has(r.id)));
  }
  if (rule.type === 'vacancy') {
    rooms = await vacantRooms(rooms, conditions.trigger, conditions.delayMinutes ?? settings.eco_delay_minutes, now);
  }

  const commands = [];
  if (rooms.length) {
    const devices = await db('devices as d')
      .join('adapters as a', 'a.id', 'd.adapter_id')
      .leftJoin('device_states as s', 's.device_id', 'd.id')
      .whereIn('d.room_id', rooms.map((r) => r.id))
      .where({ 'd.is_active': true, 'a.is_enabled': true })
      .whereIn('d.type', [...new Set(rule.actions.map((a) => DEVICE_FOR_ACTION[a.type]))])
      .select('d.*', 's.state', 'a.id as a_id', 'a.name as a_name', 'a.vendor', 'a.config', 'a.updated_at as a_updated_at');
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

  const [runId] = await db('rule_runs').insert({ rule_id: rule.id, trigger, status: 'running', rooms_matched: rooms.length, triggered_by: staffId });

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
  await db('rule_runs').where({ id: runId }).update({
    status, commands_sent: sent, commands_failed: failed, finished_at: new Date(),
    details: json({ rooms: rooms.slice(0, 200).map((r) => r.number), failures: failures.slice(0, 50) }),
  });
  await db('rules').where({ id: rule.id }).update({ last_run_at: now, last_run_status: status });
  const run = toRun(await db('rule_runs').where({ id: runId }).first());
  bus.publish(EVENTS.RULE_RUN, { ruleId: rule.id, run });
  return run;
}

export async function runRuleNow(id, actor) {
  const rule = await db('rules').where({ id }).first();
  if (!rule) throw notFound('Rule');
  const run = await runRule(rule, 'manual', { staffId: actor.id });
  await audit({ actor: { type: 'staff', id: actor.id }, action: 'rule.run', entityType: 'rule', entityId: id, details: { runId: run?.id, status: run?.status }, ip: actor.ip });
  return run;
}

/** Called every minute by the job runner. */
export async function tickRules(now = new Date()) {
  const settings = await getSettings();
  const rules = await db('rules').where({ is_enabled: true });
  const runs = [];
  for (const rule of rules) {
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
      await db('rules').where({ id: rule.id }).update({ last_run_at: now, last_run_status: 'failed' });
    }
  }
  return runs;
}
