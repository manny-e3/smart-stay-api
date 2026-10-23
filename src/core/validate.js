import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Validates req.params / req.query / req.body with zod schemas.
 * Parsed values go on req.valid because Express 5 makes req.query read-only.
 */
export function validate(schemas) {
  return (req, res, next) => {
    req.valid = req.valid || {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        throw badRequest(
          'Validation failed',
          result.error.issues.map((i) => ({ field: [part, ...i.path].join('.'), message: i.message })),
        );
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
};

/** "a,b,c" -> ['a','b','c'] restricted to allowed values. */
export const csvEnum = (values) =>
  z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const boolish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
