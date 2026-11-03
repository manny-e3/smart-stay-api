import * as requestsService from '../services/requests.service.js';

const actor = (req) => ({ id: req.staff.id, ip: req.ip });

/** GET /admin/requests. assignedTo=me means the signed-in staff member. */
export async function list(req, res) {
  const query = { ...req.valid.query };
  if (query.assignedTo === 'me') query.assignedTo = req.staff.id;
  res.json({ success: true, data: await requestsService.listRequests(query) });
}

/** GET /admin/requests/assignees */
export async function assignees(req, res) {
  res.json({ success: true, data: await requestsService.listAssignees() });
}

/** GET /admin/requests/:id */
export async function get(req, res) {
  res.json({ success: true, data: await requestsService.getRequest(req.valid.params.id) });
}

/** POST /admin/requests */
export async function create(req, res) {
  res.status(201).json({ success: true, data: await requestsService.createRequestForGuest(req.valid.body, actor(req)) });
}

/** PATCH /admin/requests/:id */
export async function update(req, res) {
  res.json({ success: true, data: await requestsService.updateRequest(req.valid.params.id, req.valid.body, actor(req)) });
}
