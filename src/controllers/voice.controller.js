import * as voiceService from '../services/voice.service.js';
import { badRequest } from '../utils/errors.js';

/** POST /guest/assistant/command (also /guest/voice-command) */
export async function command(req, res) {
  const { noRoom, ...result } = await voiceService.handleVoiceCommand(req.guest, req.valid.body.speechText);
  // Without a room the answer is sent at the top level (no "data"), as the app expects.
  if (noRoom) return res.json({ success: true, ...result });
  res.json({ success: true, data: result });
}

/** POST /guest/assistant/audio (transcribe audio clip and execute voice command) */
export async function audioCommand(req, res) {
  let buffer = req.file?.buffer;
  let mimeType = req.file?.mimetype;
  if (!buffer?.length && req.body?.audioBase64) {
    buffer = Buffer.from(String(req.body.audioBase64), 'base64');
    mimeType = req.body.mimeType || 'audio/mp4';
  }
  if (!buffer?.length) throw badRequest('Audio file is required');
  const transcript = await voiceService.transcribeAudio(buffer, mimeType);
  const { noRoom, ...result } = await voiceService.handleVoiceCommand(req.guest, transcript);
  if (noRoom) return res.json({ success: true, transcript, ...result });
  res.json({ success: true, data: { ...result, transcript } });
}
