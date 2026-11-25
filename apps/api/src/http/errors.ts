export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  /** Sent as Retry-After by error handlers that support it (the partner scope). */
  retryAfterSeconds?: number;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, 'bad_request', message, details);
}

export function unauthorized(message = 'Authentication required'): AppError {
  return new AppError(401, 'unauthorized', message);
}

export function forbidden(message = 'Forbidden'): AppError {
  return new AppError(403, 'forbidden', message);
}

export function notFound(message = 'Not found'): AppError {
  return new AppError(404, 'not_found', message);
}

export function conflict(message = 'Conflict', details?: unknown): AppError {
  return new AppError(409, 'conflict', message, details);
}

export function serviceUnavailable(message = 'Service unavailable', details?: unknown): AppError {
  return new AppError(503, 'service_unavailable', message, details);
}

export function notImplemented(message = 'Not implemented'): AppError {
  return new AppError(501, 'not_implemented', message);
}
