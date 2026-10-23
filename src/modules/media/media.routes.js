import fs from 'node:fs';
import { Router } from 'express';
import { db } from '../../config/db.js';
import { verifySignedPath } from '../../core/crypto.js';
import { AppError, notFound } from '../../core/errors.js';
import { privatePath } from '../../core/storage.js';
import { validate, idParam } from '../../core/validate.js';

/**
 * Private files behind signed, expiring URLs, so they can be used directly in <img src>.
 * The URLs come from authenticated endpoints (e.g. GET /admin/feedback).
 */
const router = Router();

router.get('/feedback-photos/:id', validate({ params: idParam }), async (req, res) => {
  const path = `/media/feedback-photos/${req.valid.params.id}`;
  if (!verifySignedPath(path, req.query.exp, req.query.sig)) throw new AppError(403, 'This link has expired', 'LINK_EXPIRED');
  const photo = await db('feedback_photos').where({ id: req.valid.params.id }).whereNotNull('storage_key').first();
  if (!photo) throw notFound('Photo');
  const file = privatePath(photo.storage_key);
  if (!fs.existsSync(file)) throw notFound('Photo');
  res.setHeader('Content-Type', photo.content_type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

export default router;
