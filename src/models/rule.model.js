import { db, paginate, json } from '../config/db.js';

/** Tables: rules (schedules and vacancy rules), rule_runs (each time a rule ran). */

export function findById(id) {
  return db('rules').where({ id }).first();
}

export function list({ type, enabled }) {
  const q = db('rules').orderBy('name');
  if (type) q.where({ type });
  if (enabled !== undefined) q.where({ is_enabled: enabled });
  return q;
}

export function listEnabled() {
  return db('rules').where({ is_enabled: true });
}

/** fields: { name, type, is_enabled, cron, target, conditions, actions, created_by? } (objects are stored as JSON). */
export async function create(fields) {
  const [id] = await db('rules').insert({ ...fields, target: json(fields.target), conditions: json(fields.conditions), actions: json(fields.actions) });
  return id;
}

export function update(id, fields) {
  const patch = { ...fields };
  for (const k of ['target', 'conditions', 'actions']) if (patch[k] !== undefined) patch[k] = json(patch[k]);
  return db('rules').where({ id }).update(patch);
}

/* ---- rule_runs ---------------------------------------------------------------- */

export function recentRuns(ruleId, limit = 20) {
  return db('rule_runs').where({ rule_id: ruleId }).orderBy('started_at', 'desc').limit(limit);
}

export function listRuns(ruleId, { page, limit }) {
  return paginate(db('rule_runs').where({ rule_id: ruleId }).orderBy('started_at', 'desc'), { page, limit });
}

export async function startRun({ ruleId, trigger, roomsMatched, triggeredBy }) {
  const [id] = await db('rule_runs').insert({ rule_id: ruleId, trigger, status: 'running', rooms_matched: roomsMatched, triggered_by: triggeredBy });
  return id;
}

export function finishRun(id, { status, sent, failed, details }) {
  return db('rule_runs').where({ id }).update({ status, commands_sent: sent, commands_failed: failed, finished_at: new Date(), details: json(details) });
}

export function findRun(id) {
  return db('rule_runs').where({ id }).first();
}
