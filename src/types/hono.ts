import type { Logger } from 'pino';
import type { AuthContext } from '../authorization/types.js';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    logger: Logger;
    auth: AuthContext;
    sessionId: string;
    limitedBodyText: string;
    clientIp: string | null;
    rateLimiter: import('../auth/rate-limit.js').RateLimiter;
    rateLimitPolicies: import('../http/limits.js').WorkRateLimitPolicies;
    limits: import('../http/limits.js').HttpLimits;
  }
}
