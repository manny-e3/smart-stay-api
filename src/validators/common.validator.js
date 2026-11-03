import { z } from 'zod';

/** Rules shared by many validators. */

/** /something/:id where id is a positive whole number. */
export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** ?page=1&limit=25, spread into a query schema: z.object({ ...pageQuery, status: ... }) */
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
};

/** "a,b,c" -> ['a','b','c'], each one of the allowed values. */
export const csvEnum = (values) =>
  z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

/** "a,b,c" -> ['a','b','c'], each checked with the given schema. */
export const listOf = (item) =>
  z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(item));

/** Query-string booleans: "true" / "false" / "1" / "0". */
export const boolish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** A JSON boolean, or a query/form-string boolean. */
export const flag = z.union([z.boolean(), boolish]);

export const DEVICE_TYPES = ['lock', 'thermostat', 'light', 'curtain', 'sensor', 'meter', 'phone', 'tv', 'speaker', 'other'];
