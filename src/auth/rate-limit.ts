import { TooManyRequestsError } from '../http/errors.js';

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
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

export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly allowedEnvironments: Array<'test' | 'development'>) {
    if (this.allowedEnvironments.length === 0) {
      throw new Error('MemoryRateLimiter cannot be used without an explicit non-production environment.');
    }
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > windowStart);

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
}
