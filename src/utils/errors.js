/**
 * Errors with an HTTP status. Throw these from services and controllers;
 * middleware/errorHandler.js turns them into the JSON error response.
 *
 *   throw notFound('Room');                 -> 404 { code: 'NOT_FOUND', message: 'Room not found' }
 *   throw badRequest('Departure must be after arrival');
 */
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
