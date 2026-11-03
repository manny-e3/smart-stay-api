import * as mappingService from '../services/mapping.service.js';
import { checkAdapterHealthById } from '../services/adapters.service.js';

const actor = (req) => ({ id: req.staff.id, ip: req.ip });

/** GET /admin/rooms/mapping */
export async function get(req, res) {
  res.json({ success: true, data: await mappingService.getMapping() });
}

/** PUT /admin/rooms/mapping */
export async function replace(req, res) {
  res.json({ success: true, data: await mappingService.putMapping(req.valid.body, actor(req)) });
}

/** GET /admin/rooms/mapping/adapters */
export async function listAdapters(req, res) {
  res.json({ success: true, data: await mappingService.listAdapters() });
}

/** POST /admin/rooms/mapping/adapters/:id/secret */
export async function rotateSecret(req, res) {
  res.json({ success: true, data: await mappingService.rotateWebhookSecret(req.valid.params.id, actor(req)) });
}

/** POST /admin/rooms/mapping/adapters/:id/check */
export async function checkAdapter(req, res) {
  const id = await checkAdapterHealthById(req.valid.params.id);
  res.json({ success: true, data: await mappingService.getAdapter(id) });
}
