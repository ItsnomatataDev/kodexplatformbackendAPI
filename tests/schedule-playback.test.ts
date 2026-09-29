import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Client } from 'minio';
import pg from 'pg';
import { createSchedulePlaybackRoutes } from '../src/routes/schedule-playback.js';
import { PostgresSchedulePlaybackStore, type SchedulePlaybackStore, type PlaybackRow } from '../src/content/schedule-playback-store.js';
import { createPlaybackSigner, PLAYBACK_CACHE_CONTROL } from '../src/content/schedule-playback-signer.js';
import { corsMiddleware } from '../src/middleware/cors.js';
import { AppError } from '../src/http/errors.js';
import { authContext, orgA, orgB } from './work-harness.js';

const schedule = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const other = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ids = [1, 2, 3, 4].map(n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`);
const asset = (id: string, type: 'video' | 'image' = 'image'): PlaybackRow => ({
  id, type, bucket: 'content-review-assets', storage_path: `${id}/media ${type === 'video' ? '+.mp4' : '.png'}`, mime_type: null,
});
const origin = 'https://player.example.com';
function appFor(store: SchedulePlaybackStore, organizationId: string | null = orgA,
  sign = async (a: PlaybackRow) => ({ id: a.id, type: a.type, url: `https://storage.example.com/${a.id}` })) {
  const app = new Hono();
  app.use('*', corsMiddleware([origin]));
  app.use('*', async (c, next) => {
    if (organizationId) c.set('auth', authContext({ membership: { organizationId }, organization: { organizationId } }));
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message }, error instanceof AppError ? error.status as ContentfulStatusCode : 500));
  app.route('/api/schedules', createSchedulePlaybackRoutes({ store, sign }));
  return app;
}
const url = (finished?: string) => `/api/schedules/${schedule}/playback${finished === undefined ? '' : `?currentAssetId=${finished}`}`;

test('route validates UUIDs, duplicate parameters, authentication and ownership before signing', async () => {
  let queries = 0;
  let signatures = 0;
  const store: SchedulePlaybackStore = { async select(org) {
    queries++;
    return { schedule_exists: org === orgA, anchor_exists: false, assets: [] };
  } };
  const app = appFor(store, orgA, async a => { signatures++; return { ...a, url: 'https://example.com' }; });
  for (const path of [url('bad'), url(''), url(ids[0]) + `&currentAssetId=${ids[1]}`, '/api/schedules/no/playback']) {
    assert.equal((await app.request(path)).status, 400);
  }
  assert.equal(queries, 0);
  assert.equal((await appFor(store, null).request(url())).status, 401);
  assert.equal((await appFor(store, orgB).request(url())).status, 404);
  assert.equal((await app.request(url(ids[3]))).status, 404);
  assert.equal(signatures, 0);
});

test('exact credentialed CORS, preflight and concurrent signing with exact top-level keys', async () => {
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  const app = appFor({ async select() { return {
    schedule_exists: true, anchor_exists: true, assets: [asset(ids[0]!, 'video'), asset(ids[1]!)],
  }; } }, orgA, async a => {
    if (++started === 2) release();
    await bothStarted;
    return { id: a.id, type: a.type, url: `https://example.com/${a.id}` };
  });
  const response = await app.request(url(), { headers: { Origin: origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(await response.json()).sort(), ['currentAsset', 'nextAsset']);
  assert.equal((await app.request(url(), { method: 'OPTIONS', headers: { Origin: origin } })).status, 204);
  assert.equal((await app.request(url(), { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('real MinIO SDK signs GET cache overrides, MIME, TTL and special object keys without network', async () => {
  const client = new Client({ endPoint: 'storage.example.com', useSSL: true, region: 'us-east-1', accessKey: 'test-access', secretKey: 'test-secret' });
  const sign = createPlaybackSigner(client);
  const video = await sign(asset(ids[0]!, 'video'));
  const parsed = new URL(video.url);
  assert.equal(parsed.searchParams.get('response-cache-control'), PLAYBACK_CACHE_CONTROL);
  assert.equal(parsed.searchParams.get('response-content-type'), 'video/mp4');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '21600');
  assert.ok(parsed.searchParams.get('X-Amz-Signature'));
  assert.match(decodeURIComponent(parsed.pathname), /media \+\.mp4$/);
  assert.equal(video.duration, undefined);
  assert.equal((await sign(asset(ids[1]!))).duration, 7);
});

// Run only against a disposable PostgreSQL database. This test creates its schema.
test('PostgreSQL + Hono: ordered initial, advance, retries, final, empty, eligibility and tenant isolation',
  { skip: !process.env.PLAYBACK_TEST_DATABASE_URL }, async () => {
    const pool = new pg.Pool({ connectionString: process.env.PLAYBACK_TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA content;
        CREATE TABLE content.schedules (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
        CREATE TABLE content.schedule_assets (
          id uuid PRIMARY KEY, schedule_id uuid NOT NULL, organization_id uuid NOT NULL,
          display_slot int NOT NULL, sort_order int NOT NULL, created_at timestamptz NOT NULL,
          asset_type text NOT NULL, bucket text NOT NULL, storage_path text, mime_type text,
          is_selected boolean NOT NULL DEFAULT true, expires_at timestamptz
        );`);
      await client.query('INSERT INTO content.schedules VALUES ($1,$2),($3,$2)', [schedule, orgA, other]);
      // Reverse insertion order: full tuple ordering, including UUID ties, must win.
      for (const id of [...ids].reverse()) {
        await client.query(`INSERT INTO content.schedule_assets
          (id,schedule_id,organization_id,display_slot,sort_order,created_at,asset_type,bucket,storage_path)
          VALUES ($1,$2,$3,0,0,'2026-01-01','image','content-review-assets','image.png')`, [id, schedule, orgA]);
      }
      const store = new PostgresSchedulePlaybackStore(client);
      const app = appFor(store);
      async function pair(finished?: string) {
        const response = await app.request(url(finished));
        assert.equal(response.status, 200);
        return await response.json() as { currentAsset: { id: string } | null; nextAsset: { id: string } | null };
      }
      assert.equal((await pair()).currentAsset?.id, ids[0]);
      assert.equal((await pair()).nextAsset?.id, ids[1]);
      const advanced = await pair(ids[0]);
      assert.equal(advanced.currentAsset?.id, ids[1]);
      assert.equal(advanced.nextAsset?.id, ids[2]);
      for (let i = 0; i < 110; i++) assert.deepEqual(await pair(ids[0]), advanced);
      assert.deepEqual(await pair(ids[2]), { currentAsset: { id: ids[3], type: 'image', url: `https://storage.example.com/${ids[3]}` }, nextAsset: null });
      assert.deepEqual(await pair(ids[3]), { currentAsset: null, nextAsset: null });
      assert.deepEqual(await (await app.request(`/api/schedules/${other}/playback`)).json(), { currentAsset: null, nextAsset: null });
      assert.equal((await app.request(`/api/schedules/${other}/playback?currentAssetId=${ids[0]}`)).status, 404);
      assert.equal((await appFor(store, orgB).request(url())).status, 404);
      // Ordering precedence: slot, then sort order, then timestamp, then UUID.
      await client.query('UPDATE content.schedule_assets SET display_slot = 1 WHERE id = $1', [ids[0]]);
      assert.equal((await pair()).currentAsset?.id, ids[1]);
      await client.query('UPDATE content.schedule_assets SET sort_order = 1 WHERE id = $1', [ids[1]]);
      assert.equal((await pair()).currentAsset?.id, ids[2]);
      await client.query(`UPDATE content.schedule_assets SET created_at = '2026-01-02' WHERE id = $1`, [ids[2]]);
      assert.equal((await pair()).currentAsset?.id, ids[3]);
      await client.query(`UPDATE content.schedule_assets SET display_slot = 0, sort_order = 0, created_at = '2026-01-01'`);
      await client.query('UPDATE content.schedule_assets SET is_selected = false WHERE id = $1', [ids[1]]);
      assert.equal((await pair(ids[0])).currentAsset?.id, ids[2]);
      assert.equal((await pair(ids[1])).currentAsset?.id, ids[2]);
      await client.query(`UPDATE content.schedule_assets SET expires_at = '2000-01-01' WHERE id = $1`, [ids[2]]);
      assert.equal((await pair(ids[0])).currentAsset?.id, ids[3]);
      await client.query('DELETE FROM content.schedule_assets');
      assert.deepEqual(await pair(), { currentAsset: null, nextAsset: null });
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
