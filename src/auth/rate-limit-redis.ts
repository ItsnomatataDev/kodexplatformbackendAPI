import { createClient, type RedisClientOptions } from 'redis';
import { ServiceUnavailableError } from '../http/errors.js';
import { redisRateLimitKey } from '../config/infrastructure-security.js';
import type { AppEnvironment } from '../config/environments.js';
import type { RateLimitResult, RateLimiter } from './rate-limit.js';

export type RedisLikeClient = {
  isOpen: boolean;
  connect(): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  ttl(key: string): Promise<number>;
  close(): Promise<void>;
};

export type RedisRateLimiterSettings = {
  appEnv: AppEnvironment;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls: boolean;
  rejectUnauthorized: boolean;
  ca?: string;
  createClient?: (options: RedisClientOptions) => RedisLikeClient;
};

const activeLimiters = new Set<RedisRateLimiter>();

export function redisClientOptions(
  settings: RedisRateLimiterSettings,
): RedisClientOptions {
  return {
    username: settings.username,
    password: settings.password,
    socket: {
      host: settings.host,
      port: settings.port,
      ...(settings.tls
        ? {
            tls: true as const,
            rejectUnauthorized: settings.rejectUnauthorized,
            ...(settings.ca ? { ca: settings.ca } : {}),
          }
        : {}),
    },
  };
}

export class RedisRateLimiter implements RateLimiter {
  private client: RedisLikeClient | null = null;
  private connecting: Promise<RedisLikeClient> | null = null;

  constructor(private readonly settings: RedisRateLimiterSettings) {
    if (settings.tls && settings.rejectUnauthorized === false) {
      throw new Error('Redis TLS cannot disable certificate verification.');
    }

    activeLimiters.add(this);
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    try {
      const client = await this.connect();
      const redisKey = redisRateLimitKey(this.settings.appEnv, key);
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
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        throw error;
      }

      throw new ServiceUnavailableError(
        'RATE_LIMIT_UNAVAILABLE',
        'Rate limiting is temporarily unavailable.',
      );
    }
  }

  async close(): Promise<void> {
    activeLimiters.delete(this);
    const client = this.client;
    this.client = null;
    this.connecting = null;

    if (client?.isOpen) {
      await client.close();
    }
  }

  private async connect(): Promise<RedisLikeClient> {
    if (this.client?.isOpen) {
      return this.client;
    }

    this.connecting ??= (async () => {
      const factory = this.settings.createClient ?? ((options) => createClient(options) as RedisLikeClient);
      const client = factory(redisClientOptions(this.settings));
      await client.connect();
      this.client = client;
      return this.client;
    })();

    return this.connecting;
  }
}

export async function closeAllRedisRateLimiters(): Promise<void> {
  const limiters = [...activeLimiters];
  await Promise.all(limiters.map((limiter) => limiter.close()));
}
