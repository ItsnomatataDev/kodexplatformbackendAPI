import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { logger } from '../config/logger.js';
import { AppError, TooManyRequestsError } from '../http/errors.js';

export function errorHandler(err: Error, c: Context) {
  const requestId = c.get('requestId') ?? c.res.headers.get('X-Request-Id');
  const requestLogger = c.get('logger') ?? logger;

  if (err instanceof AppError) {
    requestLogger.warn(
      {
        err,
        requestId,
        code: err.code,
        status: err.status,
      },
      err.message,
    );

    if (err instanceof TooManyRequestsError) {
      c.header('Retry-After', String(err.retryAfterSeconds));
    }

    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          requestId,
        },
      },
      err.status as ContentfulStatusCode,
    );
  }

  requestLogger.error({ err, requestId }, 'Unhandled error');

  return c.json(
    {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
        requestId,
      },
    },
    500,
  );
}
