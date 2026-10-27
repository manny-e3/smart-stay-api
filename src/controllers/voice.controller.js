import * as voiceService from '../services/voice.service.js';

/** POST /guest/assistant/command (also /guest/voice-command) */
export async function command(req, res) {
  const { noRoom, ...result } = await voiceService.handleVoiceCommand(req.guest, req.valid.body.speechText);
  // Without a room the answer is sent at the top level (no "data"), as the app expects.
  if (noRoom) return res.json({ success: true, ...result });
  res.json({ success: true, data: result });
}
