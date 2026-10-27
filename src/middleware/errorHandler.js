import { AppError } from '../utils/errors.js';

/** 404 for any URL that no route matched. */
export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.originalUrl}` });
}

/**
 * Turns any thrown error into { success: false, code, message, details? }.
 * Express recognises error handlers by their four arguments, so `next` must stay.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = err.status || err.statusCode || 500;
  let message = err.message;
  let code = err.code;

  if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
    code = 'BAD_REQUEST';
  } else if (err.code === 'ER_DUP_ENTRY') {
    status = 409;
    message = 'A record with these details already exists';
    code = 'CONFLICT';
  }

  // Unexpected errors are hidden; deliberate AppErrors (e.g. 502 UNLOCK_FAILED) keep their code and message.
  if (status >= 500 && !(err instanceof AppError)) {
    console.error(err);
    if (process.env.NODE_ENV === 'production') message = 'Internal server error';
    code = 'INTERNAL';
  }

  res.status(status).json({ success: false, code, message, ...(err.details ? { details: err.details } : {}) });
}
