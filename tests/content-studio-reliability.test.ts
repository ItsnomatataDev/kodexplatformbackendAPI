import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisMediaCapabilityStore, type CapabilityClient } from '../src/content/redis-capability.js';
import { persistMediaUpload } from '../src/content/upload.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { CONTENT_REVIEW_ASSETS_BUCKET as bucket } from '../src/content/buckets.js';
import { PostgresContentStore } from '../src/content/postgres-store.js';
import { db } from '../src/db/pool.js';
import type { CreateScheduleAssetInput } from '../src/content/store.js';

const grant = { organizationId: 'org', objectKey: 'org/new-upload.png' };

test('shared capabilities survive API replacement, remain reusable, and expire without renewal', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const entries = new Map<string, { value: string; expires: number }>();
  const backend: CapabilityClient = {
    isReady: true, async connect() {},
    async set(key, value, { PX }) { entries.set(key, { value, expires: Date.now() + PX }); },
    async get(key) { const e = entries.get(key); return e && e.expires > Date.now() ? e.value : null; },
  };
  const first = new RedisMediaCapabilityStore(backend, 'test');
  const token = await first.issue(grant);
  assert(![...entries.keys()][0]!.includes(token), 'raw capability is not stored as a Redis key');
  const replacement = new RedisMediaCapabilityStore(backend, 'test');
  assert.deepEqual(await replacement.consume(token), grant);
  assert.deepEqual(await replacement.consume(token), grant);
  assert.equal(await new RedisMediaCapabilityStore(backend, 'other-env').consume(token), null);
  t.mock.timers.tick(60_000);
  assert.equal(await replacement.consume(token), null);
});

test('Redis outages fail closed and malformed credentials do not reach Redis', async () => {
  let gets = 0;
  const backend: CapabilityClient = {
    isReady: true, async connect() {},
    async set() { throw Error('offline'); },
    async get() { gets++; throw Error('offline'); },
  };
  const store = new RedisMediaCapabilityStore(backend, 'test');
  assert.equal(await store.consume('invalid'), null);
  assert.equal(gets, 0);
  await assert.rejects(store.issue(grant), { code: 'CONTENT_MEDIA_CAPABILITY_UNAVAILABLE' });
  await assert.rejects(store.consume('a'.repeat(43)), { code: 'CONTENT_MEDIA_CAPABILITY_UNAVAILABLE' });
});

for (const state of ['unreferenced', 'committed', 'database-unavailable'] as const) {
  test(`failed upload cleanup is safe when ${state}`, async () => {
    const files = new MemoryFileStorage();
    await files.putObject({ bucket, objectKey: grant.objectKey, body: Buffer.from('bytes') });
    const original = Error('metadata save failed');
    await assert.rejects(persistMediaUpload({ ...grant, files, store: {
      async findMediaOwnership() {
        if (state === 'database-unavailable') throw Error('offline');
        return state === 'committed';
      },
    } }, async () => { throw original; }), (error) => error === original);
    assert.equal(Boolean(await files.getObject(bucket, grant.objectKey)), state !== 'unreferenced');
  });
}

test('cleanup failures preserve the original upload error', async () => {
  const files = new MemoryFileStorage();
  files.deleteObject = async () => { throw Error('storage offline'); };
  const original = Error('save failed');
  await assert.rejects(persistMediaUpload({ ...grant, files, store: {
    async findMediaOwnership() { return false; },
  } }, async () => { throw original; }), (error) => error === original);
});

for (const fail of [false, true]) {
  test(`schedule and library metadata use one transaction (${fail ? 'rollback' : 'commit'})`, async (t) => {
    const sql: string[] = [];
    const client = {
      on() {}, removeListener() {}, release() {},
      async query(statement: string) { sql.push(statement); return { rows: [] }; },
    };
    t.mock.method(db, 'connect', async () => client);
    const store = new PostgresContentStore();
    const events: string[] = [];
    t.mock.method(store, 'createClientMedia', async (...[_input, connection]: Parameters<PostgresContentStore['createClientMedia']>) => {
      assert.equal(connection, client); events.push('library'); return { id: 'library-id' };
    });
    t.mock.method(store, 'createAsset', async (...[input, connection]: Parameters<PostgresContentStore['createAsset']>) => {
      assert.equal(connection, client); assert.equal(input.libraryMediaId, 'library-id');
      events.push('asset'); if (fail) throw Error('insert failed'); return { id: 'asset-id' };
    });
    const operation = store.createUploadedAsset({} as CreateScheduleAssetInput, 'client-id');
    if (fail) await assert.rejects(operation, /insert failed/);
    else assert.equal((await operation).id, 'asset-id');
    assert.deepEqual(events, ['library', 'asset']);
    assert.deepEqual(sql, ['BEGIN', fail ? 'ROLLBACK' : 'COMMIT']);
  });
}

for (const fail of [false, true]) {
  test(`review lock and writes share one transaction (${fail ? 'rollback' : 'commit'})`, async (t) => {
    const statements: string[] = [];
    const client = {
      on() {}, removeListener() {}, release() {},
      async query(sql: string) { statements.push(sql); return { rows: [] }; },
    };
    t.mock.method(db, 'connect', async () => client);
    t.mock.method(db, 'query', () => { throw Error('Review escaped its transaction'); });
    const store = new PostgresContentStore();
    const operation = store.withReviewTransaction('org', 'schedule', async (scoped) => {
      await scoped.getSchedule('org', 'schedule');
      await scoped.recordActivity({ organizationId: 'org', scheduleId: 'schedule', officeId: 'office', actorUserId: null, activityType: 'approval' });
      if (fail) throw Error('review failed');
    });
    if (fail) await assert.rejects(operation, /review failed/);
    else await operation;
    assert.equal(statements[0], 'BEGIN');
    assert.match(statements[1]!, /organization_id = \$1 AND id = \$2 FOR UPDATE/);
    assert.equal(statements.at(-1), fail ? 'ROLLBACK' : 'COMMIT');
  });
}

test('schedule month collisions return a specific conflict without hiding other database failures', async () => {
  for (const constraint of ['content_schedules_client_month_uq', 'other_unique_constraint']) {
    const failure = Object.assign(new Error('database detail must not reach clients'), { code: '23505', constraint });
    const store = new PostgresContentStore({ query: async () => { throw failure; } });
    await assert.rejects(store.updateSchedule('org', 'schedule', {
      status: 'sent_to_client', scheduledAt: new Date('2026-08-31T22:00:00.000Z'),
    }), (error: unknown) => {
      if (constraint === 'other_unique_constraint') return error === failure;
      const conflict = error as { status: number; code: string; message: string };
      assert.equal(conflict.status, 409);
      assert.equal(conflict.code, 'CONTENT_SCHEDULE_MONTH_CONFLICT');
      assert.doesNotMatch(conflict.message, /database detail/);
      return true;
    });
  }
});
