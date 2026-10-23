import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { badRequest } from './errors.js';

/**
 * Private file storage on local disk (STORAGE_DIR, default ./storage). Files here are never
 * served directly; they are streamed through signed, expiring URLs (see /media routes).
 * Swap this module for a cloud bucket later without changing callers.
 */
const ROOT = path.resolve(process.env.STORAGE_DIR || 'storage');

// Detects the real image type from the file's first bytes; the client's content type is ignored.
const SIGNATURES = [
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { type: 'image/heic', ext: 'heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1')) },
];

export function detectImage(buffer) {
  return SIGNATURES.find((s) => buffer.length > 12 && s.test(buffer)) ?? null;
}

/** Validates and stores an image. Returns { key, contentType, sizeBytes }. */
export async function savePrivateImage(buffer, folder, { maxBytes = 5 * 1024 * 1024 } = {}) {
  if (buffer.length > maxBytes) throw badRequest(`Each photo must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller`);
  const kind = detectImage(buffer);
  if (!kind) throw badRequest('Photos must be JPEG, PNG, WebP or HEIC images');
  const key = `${folder}/${randomUUID()}.${kind.ext}`;
  const file = path.join(ROOT, key);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, buffer, { flag: 'wx' });
  return { key, contentType: kind.type, sizeBytes: buffer.length };
}

/** Absolute path of a stored file, refusing keys that try to leave the storage folder. */
export function privatePath(key) {
  const file = path.resolve(ROOT, key);
  if (!file.startsWith(ROOT + path.sep)) throw badRequest('Invalid file key');
  return file;
}

export async function deletePrivate(key) {
  await fs.promises.rm(privatePath(key), { force: true });
}
