import type { RedisClientType } from 'redis';
import { db } from '../db/pool.js';
import { env } from '../config/env.js';

export const CHAT_HEARTBEAT_MS = 25_000;
export const CHAT_PRESENCE_TTL_MS = 75_000;
export type Presence = { userId: string; status: 'online' | 'offline' | 'unknown'; lastSeenAt: string | null };

// Each connection has its own lease. Lua makes prune/update/count atomic across servers.
export const PRESENCE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if ARGV[3] == 'touch' then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
elseif ARGV[3] == 'close' then
  redis.call('ZREM', KEYS[1], ARGV[4])
end
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return redis.call('ZCARD', KEYS[1])
`;

export class ChatPresence {
  constructor(
    private readonly redis: () => RedisClientType | null,
    private readonly database = db,
    private readonly now = Date.now,
  ) {}

  private key(organizationId: string, userId: string) {
    return `kode:${env.appEnv}:chat-presence:${organizationId}:${userId}`;
  }

  async update(organizationId: string, userId: string, connectionId: string, action: 'touch' | 'close'): Promise<Presence> {
    const at = this.now();
    const client = this.redis();
    if (!client?.isReady) return { userId, status: 'unknown', lastSeenAt: null };
    const count = Number(await client.eval(PRESENCE_SCRIPT, {
      keys: [this.key(organizationId, userId)],
      arguments: [String(at), String(at + CHAT_PRESENCE_TTL_MS), action, connectionId, String(CHAT_PRESENCE_TTL_MS)],
    }));
    if (action === 'touch') {
      // Store actual observed activity, not the later lease-expiration time.
      await this.database.query(`INSERT INTO chat.user_presence (organization_id, user_id, last_seen_at)
        VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id)
        DO UPDATE SET last_seen_at = GREATEST(chat.user_presence.last_seen_at, EXCLUDED.last_seen_at)`,
      [organizationId, userId, new Date(at)]);
    }
    const { rows } = await this.database.query<{ last_seen_at: Date }>(
      'SELECT last_seen_at FROM chat.user_presence WHERE organization_id = $1 AND user_id = $2',
      [organizationId, userId],
    );
    return { userId, status: count > 0 ? 'online' : 'offline', lastSeenAt: rows[0]?.last_seen_at.toISOString() ?? null };
  }

  async snapshot(organizationId: string, userIds: string[]): Promise<Presence[]> {
    if (!userIds.length) return [];
    const { rows } = await this.database.query<{ user_id: string; last_seen_at: Date | null }>(
      `SELECT DISTINCT m.user_id, p.last_seen_at FROM organizations.memberships m
       LEFT JOIN chat.user_presence p ON p.organization_id = m.organization_id AND p.user_id = m.user_id
       WHERE m.organization_id = $1 AND m.status = 'active' AND m.user_id = ANY($2::uuid[])`,
      [organizationId, userIds],
    );
    const client = this.redis();
    return Promise.all(rows.map(async (row) => ({
      userId: row.user_id,
      status: !client?.isReady ? 'unknown' as const :
        await client.zCount(this.key(organizationId, row.user_id), `(${this.now()}`, '+inf') > 0 ? 'online' as const : 'offline' as const,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    })));
  }
}
