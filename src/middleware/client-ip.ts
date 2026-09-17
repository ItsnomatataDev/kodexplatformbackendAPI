import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { resolveClientIp } from '../http/client-ip.js';

type IncomingSocket = {
  incoming?: {
    socket?: {
      remoteAddress?: string;
    };
  };
};

export function getRemoteAddress(c: Context): string | null {
  const env = c.env as IncomingSocket | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
}

export function clientIpMiddleware(trustedProxyIps: readonly string[]) {
  return createMiddleware(async (c, next) => {
    c.set(
      'clientIp',
      resolveClientIp({
        remoteAddress: getRemoteAddress(c),
        forwardedFor: c.req.header('x-forwarded-for'),
        realIp: c.req.header('x-real-ip'),
        trustedProxyIps,
      }),
    );
    await next();
  });
}
