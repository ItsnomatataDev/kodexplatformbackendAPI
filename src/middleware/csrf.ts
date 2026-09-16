import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { ForbiddenError } from '../http/errors.js';
import { tokensMatch } from '../auth/opaque-token.js';
import { CSRF_COOKIE } from '../auth/cookies.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfMiddleware(allowedOrigins: string[]) {
  return createMiddleware(async (c, next) => {
    if (safeMethods.has(c.req.method)) {
      await next();
      return;
    }

    const origin = c.req.header('origin');
    const cookieHeader = c.req.header('cookie');

    if (origin && !allowedOrigins.includes(origin)) {
      throw new ForbiddenError(
        'CSRF_ORIGIN_REJECTED',
        'The request origin is not allowed.',
      );
    }

    if (cookieHeader) {
      if (!origin || !allowedOrigins.includes(origin)) {
        throw new ForbiddenError(
          'CSRF_ORIGIN_REQUIRED',
          'Browser credentialed requests must include an allowed Origin.',
        );
      }

      const csrfCookie = getCookie(c, CSRF_COOKIE);
      const csrfHeader = c.req.header('x-csrf-token');

      if (csrfCookie) {
        if (!csrfHeader || !tokensMatch(csrfCookie, csrfHeader)) {
          throw new ForbiddenError(
            'CSRF_TOKEN_INVALID',
            'The CSRF token is missing or invalid.',
          );
        }
      }
    }

    await next();
  });
}
