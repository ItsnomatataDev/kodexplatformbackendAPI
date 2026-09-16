import { createMiddleware } from 'hono/factory';
import type { AppEnvironment } from '../config/environments.js';

export function securityHeadersMiddleware(appEnv: AppEnvironment) {
  return createMiddleware(async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    c.header('Cross-Origin-Resource-Policy', 'same-site');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('X-Permitted-Cross-Domain-Policies', 'none');
    c.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    c.header('Cache-Control', 'no-store');

    if (appEnv !== 'development') {
      c.header(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }

    await next();
  });
}
