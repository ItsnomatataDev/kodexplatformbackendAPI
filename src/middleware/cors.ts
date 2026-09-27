import { createMiddleware } from 'hono/factory';

function applyCorsHeaders(
  headers: Headers,
  origin: string,
) {
  headers.set('Access-Control-Allow-Origin', origin);
  headers.append('Vary', 'Origin');
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-CSRF-Token, X-Request-Id, X-Kode-Ingest-Token',
  );
  headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  );
  headers.set('Access-Control-Max-Age', '600');
}

export function corsMiddleware(allowedOrigins: string[]) {
  return createMiddleware(async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      await next();
      return;
    }

    const origin = c.req.header('origin');
    const allowOrigin =
      Boolean(origin) && allowedOrigins.includes(origin as string);

    if (c.req.method === 'OPTIONS') {
      if (!allowOrigin || !origin) {
        return c.body(null, 403);
      }
      applyCorsHeaders(c.res.headers, origin);
      return c.body(null, 204);
    }

    await next();

    // Re-apply after the handler. Routes that return `new Response(...)`
    // (streamed MinIO media) replace the response and would otherwise drop
    // Access-Control-* headers set before next(), breaking browser blob fetches.
    if (allowOrigin && origin) {
      applyCorsHeaders(c.res.headers, origin);
    }
  });
}
