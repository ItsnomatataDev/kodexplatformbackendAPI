import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { logger } from '../config/logger.js';

function resolveRequestId(headerValue: string | undefined): string {
  if (headerValue && /^[\w.-]{8,128}$/.test(headerValue)) {
    return headerValue;
  }

  return randomUUID();
}

export const requestContext = createMiddleware(async (c, next) => {
  const requestId = resolveRequestId(c.req.header('x-request-id'));
  const requestLogger = logger.child({ requestId });

  c.set('requestId', requestId);
  c.set('logger', requestLogger);
  c.header('X-Request-Id', requestId);

  const started = Date.now();

  await next();

  requestLogger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - started,
    },
    'request',
  );
});
