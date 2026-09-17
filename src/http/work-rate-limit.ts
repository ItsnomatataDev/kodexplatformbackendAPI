import type { Context } from 'hono';
import type { AuthContext } from '../authorization/types.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { enforceRateLimit } from '../auth/rate-limit.js';
import { getAuth } from '../auth/middleware.js';
import type { WorkRateLimitPolicies } from './limits.js';

export type WorkRateLimitKind = 'mutation' | 'attachment';

export async function enforceWorkRateLimit(
  limiter: RateLimiter,
  auth: AuthContext,
  ipAddress: string | null,
  policies: WorkRateLimitPolicies,
  kind: WorkRateLimitKind,
): Promise<void> {
  const ip = ipAddress ?? 'unknown';

  if (kind === 'attachment') {
    await enforceRateLimit(
      limiter,
      `work:attach:user:${auth.actor.userId}`,
      policies.attachment.limit,
      policies.attachment.windowSeconds,
    );
    await enforceRateLimit(
      limiter,
      `work:attach:org:${auth.membership.organizationId}`,
      policies.attachmentOrg.limit,
      policies.attachmentOrg.windowSeconds,
    );
    await enforceRateLimit(
      limiter,
      `work:attach:ip:${ip}`,
      policies.attachmentIp.limit,
      policies.attachmentIp.windowSeconds,
    );
    return;
  }

  await enforceRateLimit(
    limiter,
    `work:mutate:user:${auth.actor.userId}`,
    policies.mutation.limit,
    policies.mutation.windowSeconds,
  );
  await enforceRateLimit(
    limiter,
    `work:mutate:org:${auth.membership.organizationId}`,
    policies.mutationOrg.limit,
    policies.mutationOrg.windowSeconds,
  );
  await enforceRateLimit(
    limiter,
    `work:mutate:ip:${ip}`,
    policies.mutationIp.limit,
    policies.mutationIp.windowSeconds,
  );
}

export async function rateLimitWork(
  c: Context,
  kind: WorkRateLimitKind,
): Promise<void> {
  const limiter = c.get('rateLimiter');
  const policies = c.get('rateLimitPolicies');
  const ipAddress = c.get('clientIp');
  await enforceWorkRateLimit(limiter, getAuth(c), ipAddress, policies, kind);
}
