export class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg = 'Bad request', details) => new AppError(400, msg, 'BAD_REQUEST', details);
export const unauthorized = (msg = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, msg, code);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, msg, 'FORBIDDEN');
export const notFound = (what = 'Resource') => new AppError(404, `${what} not found`, 'NOT_FOUND');
export const conflict = (msg) => new AppError(409, msg, 'CONFLICT');

export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// Express recognises error handlers by their four arguments.
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
