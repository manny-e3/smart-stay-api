import { badRequest } from '../utils/errors.js';

/**
 * Checks req.params / req.query / req.body against zod schemas from src/validators.
 * Clean values are put on req.valid (Express 5 makes req.query read-only), so controllers
 * always read req.valid.body, req.valid.query and req.valid.params.
 *
 *   router.post('/', validate({ body: createStaffSchema }), controller.create)
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
