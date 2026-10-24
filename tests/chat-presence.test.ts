import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { ChatPresence, CHAT_PRESENCE_TTL_MS } from '../src/chat/presence.js';

// Use disposable databases only. No application environment connection is used.
test('shared presence: multiple connections, crash expiry, durable last-seen and tenant isolation', {
  skip: !process.env.CHAT_TEST_POSTGRES_URL || !process.env.CHAT_TEST_REDIS_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.CHAT_TEST_POSTGRES_URL });
  const redis = createClient({ url: process.env.CHAT_TEST_REDIS_URL }) as RedisClientType;
  await redis.connect();
  const org = randomUUID(), otherOrg = randomUUID(), user = randomUUID(), otherUser = randomUUID();
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS organizations;
      CREATE SCHEMA IF NOT EXISTS identity;
      CREATE SCHEMA IF NOT EXISTS chat;
      CREATE TABLE IF NOT EXISTS organizations.organizations (id UUID PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS identity.users (id UUID PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS organizations.memberships (organization_id UUID, user_id UUID, status TEXT);`);
    await pool.query(await readFile(new URL('../migrations/0065_chat_presence.sql', import.meta.url), 'utf8'));
    await pool.query('INSERT INTO organizations.organizations VALUES ($1), ($2)', [org, otherOrg]);
    await pool.query('INSERT INTO identity.users VALUES ($1), ($2)', [user, otherUser]);
    await pool.query("INSERT INTO organizations.memberships VALUES ($1, $2, 'active'), ($3, $4, 'active')", [org, user, otherOrg, otherUser]);
    let now = Date.now();
    const serverA = new ChatPresence(() => redis, pool, () => now);
    const serverB = new ChatPresence(() => redis, pool, () => now);
    assert.equal((await serverA.update(org, user, 'tab-a', 'touch')).status, 'online');
    assert.equal((await serverB.update(org, user, 'phone-b', 'touch')).status, 'online');
    assert.equal((await serverA.update(org, user, 'tab-a', 'close')).status, 'online');
    assert.equal((await serverA.snapshot(org, [user]))[0]?.status, 'online');
    assert.equal((await serverB.update(org, user, 'phone-b', 'close')).status, 'offline');
    assert.equal((await serverA.snapshot(org, [otherUser])).length, 0);

    await serverA.update(org, user, 'crashed-server', 'touch');
    const lastActivity = new Date(now).toISOString();
    now += CHAT_PRESENCE_TTL_MS;
    const expired = (await serverB.snapshot(org, [user]))[0]!;
    assert.equal(expired.status, 'offline', 'lease expires at the deadline without a close event');
    assert.equal(expired.lastSeenAt, lastActivity);
    await serverA.update(org, user, 'crashed-server', 'close');
    assert.equal((await serverB.snapshot(org, [user]))[0]?.lastSeenAt, lastActivity, 'timeout cleanup must not invent new activity');

    const unavailable = new ChatPresence(() => null, pool, () => now);
    assert.equal((await unavailable.snapshot(org, [user]))[0]?.status, 'unknown');
    assert.equal((await unavailable.update(org, user, 'offline-redis', 'touch')).status, 'unknown');
    assert.equal((await new ChatPresence(() => redis, pool, () => now).snapshot(org, [user]))[0]?.lastSeenAt, lastActivity, 'last-seen survives a service restart');
  } finally {
    await pool.query('DELETE FROM organizations.memberships WHERE organization_id = ANY($1::uuid[])', [[org, otherOrg]]);
    await pool.query('DELETE FROM organizations.organizations WHERE id = ANY($1::uuid[])', [[org, otherOrg]]);
    await pool.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [[user, otherUser]]);
    await redis.quit();
    await pool.end();
  }
});
