import multer from 'multer';
import { badRequest } from '../utils/errors.js';

export const MAX_PHOTOS = 3;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: MAX_PHOTOS, fields: 10 } });

/**
 * Reads up to 3 photos from a multipart/form-data "photos" field into req.files.
 * JSON requests pass straight through, so the same route accepts both.
 */
export function photoUpload(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  upload.array('photos', MAX_PHOTOS)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = {
        LIMIT_FILE_SIZE: 'Each photo must be 5 MB or smaller',
        LIMIT_FILE_COUNT: `Up to ${MAX_PHOTOS} photos`,
        LIMIT_UNEXPECTED_FILE: `Send photos in the "photos" field, up to ${MAX_PHOTOS}`,
      }[err.code];
      return next(badRequest(msg || err.message));
    }
    next(err);
  });
}
