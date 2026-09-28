import { createHash, randomBytes } from 'node:crypto';
import { createClient } from 'redis';
import { redisClientOptions } from '../auth/rate-limit-redis.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ServiceUnavailableError } from '../http/errors.js';
import type { MediaCapability } from './media-capability.js';

export type CapabilityClient = {
  isReady: boolean;
  connect(): Promise<unknown>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

/** Shared, opaque capabilities; Redis expiry is absolute and reads never extend it. */
export class RedisMediaCapabilityStore {
  private connecting: Promise<unknown> | undefined;
  constructor(private readonly client: CapabilityClient, private readonly namespace: string) {}

  private key(token: string) {
    return `${this.namespace}:content-media-cap:${createHash('sha256').update(token).digest('hex')}`;
  }

  private async ready() {
    if (!this.client.isReady) {
      this.connecting ??= this.client.connect().finally(() => { this.connecting = undefined; });
      await this.connecting;
    }
  }

  async issue(value: MediaCapability, ttlMs = 60_000) {
    try {
      await this.ready();
      const token = randomBytes(32).toString('base64url');
      await this.client.set(this.key(token), JSON.stringify(value), { PX: ttlMs });
      return token;
    } catch {
      throw new ServiceUnavailableError('CONTENT_MEDIA_CAPABILITY_UNAVAILABLE', 'Media access is temporarily unavailable.');
    }
  }

  async consume(token: string): Promise<MediaCapability | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    try {
      await this.ready();
      const raw = await this.client.get(this.key(token));
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (typeof value?.organizationId !== 'string' || typeof value?.objectKey !== 'string') return null;
      return { organizationId: value.organizationId, objectKey: value.objectKey };
    } catch {
      throw new ServiceUnavailableError('CONTENT_MEDIA_CAPABILITY_UNAVAILABLE', 'Media access is temporarily unavailable.');
    }
  }
}

let client: ReturnType<typeof createClient> | undefined;
let store: RedisMediaCapabilityStore | undefined;
export function sharedMediaCapabilityStore() {
  if (!store) {
    const options = redisClientOptions({ ...env.redis, appEnv: env.appEnv });
    client = createClient({ ...options, disableOfflineQueue: true,
      socket: { ...options.socket, connectTimeout: 3000, reconnectStrategy: false } });
    client.on('error', (err) => logger.error({ err }, 'Media capability Redis connection failed'));
    store = new RedisMediaCapabilityStore(client, `kode:${env.appEnv}`);
  }
  return store;
}

export async function closeMediaCapabilities() {
  if (client?.isOpen) await client.close();
  client = undefined;
  store = undefined;
}
