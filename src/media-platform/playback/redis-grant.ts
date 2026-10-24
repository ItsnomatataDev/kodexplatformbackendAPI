import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import { ServiceUnavailableError } from '../../http/errors.js';
import { redisClientOptions } from '../../auth/rate-limit-redis.js';
import type { AppEnvironment } from '../../config/environments.js';

export type PlaybackGrant = {
  signature: string;
  assetId: string;
  generation: string | null;
  organizationId: string;
  userId: string;
  expiresAt: number;
};

export type PlaybackGrantStore = {
  issue(grant: PlaybackGrant, ttlMs: number): Promise<void>;
  get(signature: string): Promise<PlaybackGrant | null>;
  revokeUser(userId: string): Promise<void>;
};

type GrantClient = {
  isReady: boolean;
  connect(): Promise<unknown>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
};

const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function digest(signature: string) {
  return createHash('sha256').update(signature).digest('hex');
}

function unavailable(): never {
  throw new ServiceUnavailableError(
    'MEDIA_PLAYBACK_UNAVAILABLE',
    'Media playback is temporarily unavailable.',
  );
}

function parseGrant(raw: string): PlaybackGrant | null {
  try {
    const value = JSON.parse(raw) as PlaybackGrant;
    if (
      typeof value?.signature !== 'string' ||
      !SIGNATURE.test(value.signature) ||
      typeof value.assetId !== 'string' ||
      !UUID.test(value.assetId) ||
      typeof value.organizationId !== 'string' ||
      !UUID.test(value.organizationId) ||
      typeof value.userId !== 'string' ||
      !UUID.test(value.userId) ||
      typeof value.expiresAt !== 'number' ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.generation != null &&
        (typeof value.generation !== 'string' ||
          !/^[1-9][0-9]{0,18}$/.test(value.generation)))
    ) {
      return null;
    }
    return {
      signature: value.signature,
      assetId: value.assetId.toLowerCase(),
      generation: value.generation ?? null,
      organizationId: value.organizationId.toLowerCase(),
      userId: value.userId.toLowerCase(),
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

export class MemoryPlaybackGrantStore implements PlaybackGrantStore {
  private readonly grants = new Map<string, { grant: PlaybackGrant; expiresAtMs: number }>();
  private readonly users = new Map<string, Set<string>>();

  async issue(grant: PlaybackGrant, ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) unavailable();
    const parsed = parseGrant(JSON.stringify(grant));
    if (!parsed) unavailable();
    const key = digest(parsed.signature);
    this.grants.set(key, { grant: parsed, expiresAtMs: Date.now() + ttlMs });
    const owned = this.users.get(parsed.userId) ?? new Set<string>();
    owned.add(key);
    this.users.set(parsed.userId, owned);
  }

  async get(signature: string) {
    if (!SIGNATURE.test(signature)) return null;
    const entry = this.grants.get(digest(signature));
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.grants.delete(digest(signature));
      return null;
    }
    return entry.grant;
  }

  async revokeUser(userId: string) {
    const owned = this.users.get(userId.toLowerCase());
    if (!owned) return;
    for (const key of owned) this.grants.delete(key);
    this.users.delete(userId.toLowerCase());
  }
}

export class RedisPlaybackGrantStore implements PlaybackGrantStore {
  private connecting: Promise<unknown> | undefined;

  constructor(
    private readonly client: GrantClient,
    private readonly namespace: string,
  ) {}

  private grantKey(signature: string) {
    return `${this.namespace}:media-playback-grant:${digest(signature)}`;
  }

  private userKey(userId: string) {
    return `${this.namespace}:media-playback-user:${userId.toLowerCase()}`;
  }

  private async ready() {
    if (!this.client.isReady) {
      this.connecting ??= this.client.connect().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
  }

  async issue(grant: PlaybackGrant, ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) unavailable();
    const parsed = parseGrant(JSON.stringify(grant));
    if (!parsed) unavailable();
    try {
      await this.ready();
      const key = this.grantKey(parsed.signature);
      await this.client.set(key, JSON.stringify(parsed), { PX: ttlMs });
      const userKey = this.userKey(parsed.userId);
      await this.client.sAdd(userKey, key);
      await this.client.expire(userKey, 86_400);
    } catch {
      unavailable();
    }
  }

  async get(signature: string) {
    if (!SIGNATURE.test(signature)) return null;
    try {
      await this.ready();
      const raw = await this.client.get(this.grantKey(signature));
      if (!raw) return null;
      return parseGrant(raw);
    } catch {
      unavailable();
    }
  }

  async revokeUser(userId: string) {
    if (!UUID.test(userId)) return;
    try {
      await this.ready();
      const userKey = this.userKey(userId);
      const keys = await this.client.sMembers(userKey);
      for (const key of keys) await this.client.del(key);
      await this.client.del(userKey);
    } catch {
      unavailable();
    }
  }
}

export function createRedisPlaybackGrantStore(settings: {
  appEnv: AppEnvironment;
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls: boolean;
  rejectUnauthorized: boolean;
  ca?: string;
}) {
  const options = redisClientOptions({ ...settings });
  const client = createClient({
    ...options,
    disableOfflineQueue: true,
    socket: {
      ...options.socket,
      connectTimeout: 3000,
      reconnectStrategy: false,
    },
  });
  client.on('error', () => undefined);
  return new RedisPlaybackGrantStore(client, `kode:${settings.appEnv}`);
}
