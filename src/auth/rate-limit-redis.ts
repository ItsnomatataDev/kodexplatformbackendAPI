import { createClient, type RedisClientType } from 'redis';
import { ServiceUnavailableError } from '../http/errors.js';
import type { RateLimitResult, RateLimiter } from './rate-limit.js';

export class RedisRateLimiter implements RateLimiter {
  private client: RedisClientType | null = null;
  private connecting: Promise<RedisClientType> | null = null;

  constructor(
    private readonly url: string,
  ) {}

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    try {
      const client = await this.connect();
      const redisKey = `kode:ratelimit:${key}`;
      const count = await client.incr(redisKey);

      if (count === 1) {
        await client.expire(redisKey, windowSeconds);
      }

      if (count > limit) {
        const ttl = await client.ttl(redisKey);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, ttl),
        };
      }

      return {
        allowed: true,
        retryAfterSeconds: windowSeconds,
      };
    } catch {
      throw new ServiceUnavailableError(
        'RATE_LIMIT_UNAVAILABLE',
        'Authentication rate limiting is temporarily unavailable.',
      );
    }
  }

  private async connect(): Promise<RedisClientType> {
    if (this.client?.isOpen) {
      return this.client;
    }

    this.connecting ??= (async () => {
      const client = createClient({ url: this.url });
      await client.connect();
      this.client = client as RedisClientType;
      return this.client;
    })();

    return this.connecting;
  }
}
