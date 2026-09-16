import { createMiddleware } from 'hono/factory';

export function corsMiddleware(allowedOrigins: string[]) {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header('origin');

    if (origin && allowedOrigins.includes(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-CSRF-Token, X-Request-Id',
      );
      c.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      );
      c.header('Access-Control-Max-Age', '600');
    }

    if (c.req.method === 'OPTIONS') {
      return c.body(null, origin && allowedOrigins.includes(origin) ? 204 : 403);
    }

    await next();
  });
}
