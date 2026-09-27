import { TooManyRequestsError } from '../http/errors.js';

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Read-only check — does not record a hit. */
  inspect(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

export async function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await limiter.consume(key, limit, windowSeconds);

  if (!result.allowed) {
    throw new TooManyRequestsError(result.retryAfterSeconds);
  }
}

export async function assertNotRateLimited(
  limiter: RateLimiter,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await limiter.inspect(key, limit, windowSeconds);

  if (!result.allowed) {
    throw new TooManyRequestsError(result.retryAfterSeconds);
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly allowedEnvironments: Array<'test' | 'development'>) {
    if (this.allowedEnvironments.length === 0) {
      throw new Error('MemoryRateLimiter cannot be used without an explicit non-production environment.');
    }
  }

  private prune(key: string, windowStart: number) {
    return (this.hits.get(key) ?? []).filter((at) => at > windowStart);
  }

  async inspect(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const recent = this.prune(key, windowStart);
    this.hits.set(key, recent);

    if (recent.length >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((recent[0] + windowSeconds * 1000 - now) / 1000),
        ),
      };
    }

    return { allowed: true, retryAfterSeconds: windowSeconds };
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const recent = this.prune(key, windowStart);

    if (recent.length >= limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((recent[0] + windowSeconds * 1000 - now) / 1000),
      );
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: windowSeconds };
  }

  /** Dev helper — drop in-memory counters (e.g. after local lockouts). */
  clear(prefix?: string) {
    if (!prefix) {
      this.hits.clear();
      return;
    }
    for (const key of this.hits.keys()) {
      if (key.startsWith(prefix)) this.hits.delete(key);
    }
  }
}
