import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { env } from '../src/config/env.js';
import { PostgresSocialStore } from '../src/social/postgres-store.js';

function probePool(statementTimeoutMs: number, idleInTransactionMs: number) {
  return new Pool({
    host: env.database.host,
    port: env.database.port,
    database: env.database.name,
    user: env.database.user,
    password: env.database.password,
    max: 2,
    connectionTimeoutMillis: 2_000,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: idleInTransactionMs,
    ssl: env.database.ssl
      ? {
          rejectUnauthorized: env.database.rejectUnauthorized,
          ...(env.database.ca ? { ca: env.database.ca } : {}),
        }
      : undefined,
  });
}

async function canQuery(pool: Pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    await pool.end().catch(() => undefined);
    return false;
  }
}

test('statement timeout cancels a slow query and the transaction can roll back', async (t) => {
  const pool = probePool(300, 60_000);
  if (!(await canQuery(pool))) {
    t.skip('PostgreSQL is not reachable with the current test credentials');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(
      () => client.query('SELECT pg_sleep(2)'),
      (error: { code?: string }) => error.code === '57014',
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  const next = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  assert.equal(Number(next.rows[0]?.ok), 1);
  await pool.end();
});

test('idle in transaction timeout ends that session and the pool still serves queries', async (t) => {
  const pool = probePool(30_000, 300);
  pool.on('error', () => undefined);
  if (!(await canQuery(pool))) {
    t.skip('PostgreSQL is not reachable with the current test credentials');
    return;
  }

  const client = await pool.connect();
  let terminated = false;
  client.on('error', (error: { code?: string; message?: string }) => {
    if (error.code === '25P03' || /idle-in-transaction/i.test(error.message ?? '')) {
      terminated = true;
    }
  });
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(terminated, true);
  } finally {
    client.release(new Error('idle-in-transaction session ended'));
  }

  const next = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  assert.equal(Number(next.rows[0]?.ok), 1);
  await pool.end();
});

test('social post list is bounded and stays inside the organization', async (t) => {
  const pool = probePool(30_000, 60_000);
  if (!(await canQuery(pool))) {
    t.skip('PostgreSQL is not reachable with the current test credentials');
    return;
  }

  const orgs = await pool.query<{ id: string }>(
    `SELECT id FROM organizations.organizations ORDER BY created_at ASC LIMIT 2`,
  );
  if (orgs.rows.length < 2) {
    await pool.end();
    t.skip('Need two organizations to prove tenant isolation');
    return;
  }

  const orgA = orgs.rows[0]!.id;
  const orgB = orgs.rows[1]!.id;
  const marker = `phase1-bound-${randomUUID()}`;
  const store = new PostgresSocialStore();

  try {
    for (let index = 0; index < 3; index += 1) {
      await pool.query(
        `INSERT INTO social.posts (organization_id, title, platform, status, priority)
         VALUES ($1, $2, 'LinkedIn', 'draft', 'medium')`,
        [orgA, `${marker}-a-${index}`],
      );
    }
    await pool.query(
      `INSERT INTO social.posts (organization_id, title, platform, status, priority)
       VALUES ($1, $2, 'LinkedIn', 'draft', 'medium')`,
      [orgB, `${marker}-b`],
    );

    const page = await store.list(orgA, { limit: 2 });
    const ours = page.posts.filter((post) => String(post.title).startsWith(marker));
    assert.equal(ours.length, 2);
    assert.equal(page.hasMore, true);
    assert.equal(
      ours.every((post) => post.organization_id === orgA),
      true,
    );
    assert.equal(
      page.posts.some((post) => post.organization_id === orgB),
      false,
    );
    const cursor = ours[ours.length - 1]!;
    const nextPage = await store.list(orgA, {
      limit: 2,
      beforeCreatedAt: String(cursor.created_at),
      beforeId: String(cursor.id),
    });
    assert.equal(
      nextPage.posts.some((post) => post.id === cursor.id),
      false,
    );
    assert.equal(
      nextPage.posts.some((post) => String(post.title).startsWith(`${marker}-a`)),
      true,
    );
    assert.equal(
      nextPage.posts.every((post) => post.organization_id === orgA),
      true,
    );

    const other = await store.list(orgB, { limit: 50 });
    const otherMarked = other.posts.filter((post) => String(post.title).startsWith(marker));
    assert.equal(otherMarked.length, 1);
    assert.equal(otherMarked[0]?.organization_id, orgB);
  } finally {
    await pool.query(`DELETE FROM social.posts WHERE title LIKE $1`, [`${marker}%`]);
    await pool.end();
  }
});
