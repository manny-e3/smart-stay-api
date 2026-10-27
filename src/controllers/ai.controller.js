import * as aiService from '../services/ai.service.js';

/** POST /admin/ai/copilot */
export async function copilot(req, res) {
  res.json({ success: true, data: { response: await aiService.copilot(req.body) } });
}

/** POST /guest/ai/guest-chat (also /admin/ai/guest-chat) */
export async function guestChat(req, res) {
  res.json({ success: true, data: await aiService.guestChat(req.body) });
}
