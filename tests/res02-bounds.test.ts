import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Pool } from 'pg';
import { env } from '../src/config/env.js';
import {
  keysetPredicate,
  listLimit,
  ORGANIZATION_LIST_LIMIT,
  pageOf,
  parseListQuery,
} from '../src/db/list-bounds.js';
import { PostgresLeaveStore } from '../src/leave/postgres-store.js';
import { MemoryBoardStore } from '../src/work/memory-store.js';

test('list limit clamps an enormous client request', () => {
  assert.equal(listLimit(999_999_999), ORGANIZATION_LIST_LIMIT);
  assert.equal(listLimit(undefined), ORGANIZATION_LIST_LIMIT);
  assert.equal(listLimit(1), 1);
  const parsed = parseListQuery({ limit: '999999', before: null, beforeId: null });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.query.limit, ORGANIZATION_LIST_LIMIT);
  assert.equal(
    parseListQuery({ limit: '10', before: 'not-a-date', beforeId: null }).ok,
    false,
  );
});

test('keyset predicate keeps a stable ordered comparison', () => {
  const params: unknown[] = ['org'];
  const desc = keysetPredicate(
    params,
    { at: '2026-01-01T00:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' },
    'created_at',
    'id',
    'desc',
  );
  assert.match(desc, /</);
  const ascParams: unknown[] = [];
  const asc = keysetPredicate(
    ascParams,
    { at: '2026-01-01T00:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' },
    'created_at',
    'id',
    'asc',
  );
  assert.match(asc, />/);
  const page = pageOf([1, 2, 3], 2);
  assert.deepEqual(page.rows, [1, 2]);
  assert.equal(page.hasMore, true);
});

test('board card query stays a full active working set', () => {
  const source = readFileSync(
    new URL('../src/work/postgres-store.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('async listCardsByBoard');
  const end = source.indexOf('async getCardById');
  const body = source.slice(start, end);
  assert.match(body, /card\.organization_id = \$1/);
  assert.match(body, /card\.board_id = \$2/);
  assert.match(body, /card\.archived_at IS NULL/);
  assert.doesNotMatch(body, /LIMIT/);
});

test('board list pages stay inside one organization', async () => {
  const store = new MemoryBoardStore();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const owner = randomUUID();
  const created: string[] = [];
  for (let position = 1; position <= 3; position += 1) {
    const board = await store.create({
      organizationId: orgA,
      createdBy: owner,
      name: `res02-a-${position}`,
      position,
    });
    created.push(board.id);
  }
  await store.create({
    organizationId: orgB,
    createdBy: owner,
    name: 'res02-b',
    position: 1,
  });

  const first = await store.listByOrganization(orgA, { limit: 2, offset: 0 });
  const second = await store.listByOrganization(orgA, { limit: 2, offset: 2 });
  assert.equal(first.boards.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(second.boards.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(
    first.boards.every((board) => board.organizationId === orgA),
    true,
  );
  assert.equal(
    second.boards.every((board) => board.organizationId === orgA),
    true,
  );
  const seen = [...first.boards, ...second.boards].map((board) => board.id);
  assert.deepEqual(new Set(seen).size, 3);
  assert.deepEqual(new Set(seen), new Set(created));
  const again = await store.listByOrganization(orgA, { limit: 2, offset: 0 });
  assert.deepEqual(
    again.boards.map((board) => board.id),
    first.boards.map((board) => board.id),
  );
});

function probePool() {
  return new Pool({
    host: env.database.host,
    port: env.database.port,
    database: env.database.name,
    user: env.database.user,
    password: env.database.password,
    max: 2,
    connectionTimeoutMillis: 2_000,
    ssl: env.database.ssl
      ? {
          rejectUnauthorized: env.database.rejectUnauthorized,
          ...(env.database.ca ? { ca: env.database.ca } : {}),
        }
      : undefined,
  });
}

test('leave request pages are capped, ordered, and tenant scoped', async (t) => {
  const pool = probePool();
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end().catch(() => undefined);
    t.skip('PostgreSQL is not reachable with the current test credentials');
    return;
  }

  const orgs = await pool.query<{ id: string }>(
    `SELECT id FROM organizations.organizations ORDER BY created_at ASC LIMIT 2`,
  );
  const user = await pool.query<{ id: string }>(
    `SELECT id FROM identity.users ORDER BY created_at ASC LIMIT 1`,
  );
  if (orgs.rows.length < 2 || !user.rows[0]) {
    await pool.end();
    t.skip('Need two organizations and one user to prove leave pagination');
    return;
  }

  const orgA = orgs.rows[0]!.id;
  const orgB = orgs.rows[1]!.id;
  const userId = user.rows[0].id;
  const marker = `res02-leave-${randomUUID()}`;
  const store = new PostgresLeaveStore();

  try {
    for (let index = 0; index < 3; index += 1) {
      await store.createRequest({
        organizationId: orgA,
        userId,
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        requestedDays: 1,
        reason: `${marker}-a-${index}`,
      });
    }
    await store.createRequest({
      organizationId: orgB,
      userId,
      startDate: '2026-09-02',
      endDate: '2026-09-02',
      requestedDays: 1,
      reason: `${marker}-b`,
    });

    const huge = await store.listMyRequests(orgA, userId, { limit: 999_999 });
    assert.ok(huge.requests.length <= ORGANIZATION_LIST_LIMIT);
    assert.equal(
      huge.requests.every((row) => row.organizationId === orgA),
      true,
    );

    const first = await store.listMyRequests(orgA, userId, { limit: 2 });
    assert.ok(first.requests.length <= 2);
    assert.equal(first.hasMore, true);
    assert.equal(
      first.requests.every((row) => row.organizationId === orgA),
      true,
    );
    const cursor = first.requests[first.requests.length - 1];
    assert.ok(cursor);
    const second = await store.listMyRequests(orgA, userId, {
      limit: 2,
      before: cursor.createdAt.toISOString(),
      beforeId: cursor.id,
    });
    const firstIds = new Set(first.requests.map((row) => row.id));
    assert.equal(
      second.requests.some((row) => firstIds.has(row.id)),
      false,
    );
    assert.equal(
      second.requests.every((row) => row.organizationId === orgA),
      true,
    );
    const marked = [...first.requests, ...second.requests].filter((row) =>
      String(row.reason ?? '').startsWith(marker),
    );
    assert.equal(marked.some((row) => row.organizationId === orgB), false);
    assert.ok(marked.some((row) => String(row.reason).startsWith(`${marker}-a`)));

    const other = await store.listMyRequests(orgB, userId, { limit: 50 });
    assert.equal(
      other.requests.every((row) => row.organizationId === orgB),
      true,
    );
    assert.equal(
      other.requests.some((row) => String(row.reason) === `${marker}-b`),
      true,
    );
    assert.equal(
      other.requests.some((row) => String(row.reason ?? '').includes(`${marker}-a`)),
      false,
    );
  } finally {
    await pool.query(`DELETE FROM leave.requests WHERE reason LIKE $1`, [
      `${marker}%`,
    ]);
    await pool.end();
  }
});
