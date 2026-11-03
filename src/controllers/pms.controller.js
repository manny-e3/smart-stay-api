import * as pmsService from '../services/pms.service.js';

const actor = (req) => ({ id: req.staff.id, ip: req.ip });

/** GET /admin/pms/connections */
export async function listConnections(req, res) {
  res.json({ success: true, data: await pmsService.listConnections() });
}

/** POST /admin/pms/connections */
export async function createConnection(req, res) {
  res.status(201).json({ success: true, data: await pmsService.createConnection(req.valid.body, actor(req)) });
}

/** PATCH /admin/pms/connections/:id */
export async function updateConnection(req, res) {
  res.json({ success: true, data: await pmsService.updateConnection(req.valid.params.id, req.valid.body, actor(req)) });
}

/** POST /admin/pms/connections/:id/secret */
export async function rotateSecret(req, res) {
  res.json({ success: true, data: await pmsService.rotateSecret(req.valid.params.id, actor(req)) });
}

/** POST /admin/pms/connections/:id/sync */
export async function syncNow(req, res) {
  res.json({ success: true, data: await pmsService.syncNow(req.valid.params.id, actor(req)) });
}

/** GET /admin/pms/events */
export async function listEvents(req, res) {
  res.json({ success: true, data: await pmsService.listEvents(req.valid.query) });
}

/** POST /admin/pms/events/:id/retry */
export async function retryEvent(req, res) {
  res.json({ success: true, data: await pmsService.retryEvent(req.valid.params.id) });
}

/** POST /integrations/pms/:id/events: the PMS pushes reservation events, signed with X-PMS-Secret. */
export async function webhook(req, res) {
  const connection = await pmsService.authenticateWebhook(req.valid.params.id, req.get('x-pms-secret'));
  const results = await pmsService.ingestEvents(connection, req.valid.body.events);
  res.status(202).json({ success: true, data: { results } });
}
