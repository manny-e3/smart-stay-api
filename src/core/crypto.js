import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM for secrets stored in the database, such as digital key credentials.
 * Output format: base64url(iv).base64url(tag).base64url(ciphertext)
 */
const key = crypto.createHash('sha256').update(env.auth.dataEncryptionSecret).digest();

export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(text) {
  if (!text) return null;
  const [iv, tag, data] = text.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Booking reference like SS7KQ2MP, without easily confused characters. */
export const bookingReference = () => 'SS' + Array.from({ length: 6 }, () => REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)]).join('');

/**
 * 8-character guest booking code, e.g. K7Q2MPX4. Unique among live codes, so the guest
 * doesn't need to type a room number. About 10^12 combinations, without confusable characters.
 */
export const accessCode = () => Array.from({ length: 8 }, () => REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)]).join('');

/** Opaque token placed in the check-in QR code. */
export const qrToken = () => crypto.randomBytes(24).toString('base64url');

/** Keyed hash used to look a booking code or QR token up without storing it. */
export const lookupHash = (value) => crypto.createHmac('sha256', env.auth.guestSecret).update(String(value).trim().toUpperCase()).digest('hex');

/** Normalises what a guest types: spaces, dashes and lower case are allowed. */
export const normaliseCode = (value) => String(value || '').replace(/[\s-]/g, '').toUpperCase();

/** Signed, expiring URL parameters for private files (feedback photos). */
export function signPath(path, ttlSeconds = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', env.auth.dataEncryptionSecret).update(`${path}:${exp}`).digest('base64url');
  return `${path}?exp=${exp}&sig=${sig}`;
}

export function verifySignedPath(path, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = crypto.createHmac('sha256', env.auth.dataEncryptionSecret).update(`${path}:${exp}`).digest('base64url');
  return expected.length === String(sig).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
}
