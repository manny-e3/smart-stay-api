import fs from 'node:fs';
import * as feedbackService from '../services/feedback.service.js';
import { notFound } from '../utils/errors.js';

/** GET /admin/feedback */
export async function list(req, res) {
  res.json({ success: true, data: await feedbackService.listFeedback(req.valid.query) });
}

/** GET /media/feedback-photos/:id?exp=&sig=  (signed link, no login needed) */
export async function photo(req, res) {
  const { file, contentType } = await feedbackService.getSignedPhoto(req.valid.params.id, req.query);
  if (!fs.existsSync(file)) throw notFound('Photo');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
}
