import * as rulesService from '../services/rules.service.js';

const actor = (req) => ({ id: req.staff.id, ip: req.ip });

/** GET /admin/rules */
export async function list(req, res) {
  res.json({ success: true, data: await rulesService.listRules(req.valid.query) });
}

/** GET /admin/rules/:id */
export async function get(req, res) {
  res.json({ success: true, data: await rulesService.getRule(req.valid.params.id) });
}

/** GET /admin/rules/:id/runs */
export async function runs(req, res) {
  res.json({ success: true, data: await rulesService.listRuns(req.valid.params.id, req.valid.query) });
}

/** POST /admin/rules */
export async function create(req, res) {
  res.status(201).json({ success: true, data: await rulesService.createRule(req.valid.body, actor(req)) });
}

/** PATCH /admin/rules/:id */
export async function update(req, res) {
  res.json({ success: true, data: await rulesService.updateRule(req.valid.params.id, req.valid.body, actor(req)) });
}

/** POST /admin/rules/:id/run */
export async function runNow(req, res) {
  res.json({ success: true, data: await rulesService.runRuleNow(req.valid.params.id, actor(req)) });
}
