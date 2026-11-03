import { receiveWebhook } from '../services/adapters.service.js';

/** POST /integrations/adapters/:id/events, called by device vendors with X-Adapter-Secret. */
export async function deviceEvents(req, res) {
  const data = await receiveWebhook(req.valid.params.id, req.get('x-adapter-secret'), req.valid.body.events);
  res.status(202).json({ success: true, data });
}
