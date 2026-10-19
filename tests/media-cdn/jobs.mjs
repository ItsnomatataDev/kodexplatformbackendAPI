import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'minio';
import { db } from '../../dist/db/pool.js';
import { PostgresMediaPlatformStore } from '../../dist/media-platform/postgres-store.js';
import { mediaGenerationPrefix } from '../../dist/media-platform/object-keys.js';
import { createMediaPlaybackUrl } from '../../dist/media-platform/playback/url.js';

const credentials = (job) => ({
  jobId: job.id,
  workerId: job.leaseOwner,
  fencingToken: job.fencingToken,
});
const expire = (id) =>
  db.query(
    "UPDATE media_platform.jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [id],
  );
const admin = new Client({
  endPoint: 'minio',
  port: 9000,
  useSSL: false,
  region: 'us-east-1',
  accessKey: 'local-test-admin',
  secretKey: 'local-test-admin-password',
});
const bucket = 'content-review-assets';
const variant = (asset, job) => ({
  assetId: asset.id,
  kind: 'hls_480p',
  width: 854,
  height: 480,
  bitrateBps: 1200000,
  codec: 'h264',
  container: 'hls',
  bucket,
  objectKey: `${mediaGenerationPrefix(asset.id, job.fencingToken)}/hls/480p/index.m3u8`,
  sizeBytes: 100,
  status: 'ready',
});
try {
  await import('./migrations.mjs');
  await db.query(`CREATE SCHEMA organizations; CREATE SCHEMA identity;
    CREATE TABLE organizations.organizations (id uuid PRIMARY KEY);
    CREATE TABLE identity.users (id uuid PRIMARY KEY);`);
  for (const name of [
    '0058_media_platform.sql',
    '0059_media_job_leases.sql',
    '0061_media_publication_fencing.sql',
  ]) {
    await db.query(await readFile(`/app/migrations/${name}`, 'utf8'));
  }
  const org = '11111111-1111-4111-8111-111111111111',
    other = '22222222-2222-4222-8222-222222222222';
  await db.query('INSERT INTO organizations.organizations VALUES ($1),($2)', [
    org,
    other,
  ]);
  const store = new PostgresMediaPlatformStore();
  const input = {
    organizationId: org,
    originalFilename: 'fixture.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1,
    originBucket: bucket,
    originObjectKey: 'source',
  };
  {
    const unsupportedAsset = await store.createAsset({
      ...input,
      originObjectKey: 'unsupported-job-filter',
    });

    const thumbnail = await store.enqueueJob({
      assetId: unsupportedAsset.id,
      jobType: 'thumbnail',
      priority: 1,
    });

    const metadata = await store.enqueueJob({
      assetId: unsupportedAsset.id,
      jobType: 'metadata',
      priority: 2,
    });

    const hls = await store.enqueueJob({
      assetId: unsupportedAsset.id,
      jobType: 'adaptive_hls',
      priority: 100,
    });

    const claimed = await store.claimNextJob({
      workerId: 'supported-job-filter-test',
      leaseMs: 90000,
    });

    assert.ok(claimed, 'a supported job must be claimable');
    assert.equal(
      claimed.id,
      hls.id,
      'the worker must skip unsupported higher-priority jobs',
    );

    const untouched = await db.query(
      `SELECT id, status, attempts
     FROM media_platform.jobs
     WHERE id = ANY($1::uuid[])`,
      [[thumbnail.id, metadata.id]],
    );

    assert.equal(untouched.rows.length, 2);

    for (const job of untouched.rows) {
      assert.equal(job.status, 'queued');
      assert.equal(job.attempts, 0);
    }

    // Finish this fixture so it cannot interfere with later job tests.
    const failed = await store.failJob({
      ...credentials(claimed),
      retryable: false,
    });

    assert.equal(failed?.status, 'failed');

    const next = await store.claimNextJob({
      workerId: 'unsupported-job-check',
      leaseMs: 90000,
    });

    assert.equal(next, null, 'unsupported jobs must remain unclaimed');
  }
  const [asset, repeated] = await Promise.all([
    store.createAssetAndJob(input),
    store.createAssetAndJob(input),
  ]);
  assert.equal(asset.id, repeated.id, 'source registration idempotent');
  assert.equal((await store.getJobsForAsset(org, asset.id)).length, 1);
  assert.equal(await store.getAssetForOrganization(other, asset.id), null);
  assert.deepEqual(await store.getJobsForAsset(other, asset.id), []);
  assert.equal(await store.enqueueForOrganization(other, asset.id), null);
  await assert.rejects(() =>
    store.createAssetAndJob({ ...input, organizationId: other }),
  );
  await store.enqueueJob({
    assetId: asset.id,
    jobType: 'adaptive_hls',
    priority: 200,
  });
  const claims = await Promise.all(
    ['worker-a', 'worker-b'].map((workerId) =>
      store.claimNextJob({ workerId, leaseMs: 90000 }),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(Boolean);
  assert.ok(await store.heartbeatJob({ ...credentials(old), leaseMs: 90000 }));
  assert.equal(
    await store.completeJob({
      ...credentials(old),
      workerId: 'intruder',
      variants: [variant(asset, old)],
    }),
    null,
  );
  await expire(old.id);
  assert.equal(
    await store.heartbeatJob({ ...credentials(old), leaseMs: 90000 }),
    null,
  );
  assert.equal(
    await store.completeJob({
      ...credentials(old),
      variants: [variant(asset, old)],
    }),
    null,
  );
  assert.deepEqual(await store.getVariantsByAssetId(asset.id), []);
  assert.equal(await store.recoverExpiredJobs(), 1);
  // Reuse worker ID deliberately: token, not worker name alone, must fence.
  const current = await store.claimNextJob({
    workerId: old.leaseOwner,
    leaseMs: 90000,
  });
  assert.equal(
    current.id,
    old.id,
    'same job reclaimed by the same worker name',
  );
  assert.ok(BigInt(current.fencingToken) > BigInt(old.fencingToken));
  assert.equal(
    await store.failJob({ ...credentials(old), retryable: false }),
    null,
  );
  assert.equal(
    await store.heartbeatJob({ ...credentials(old), leaseMs: 90000 }),
    null,
  );
  const newKey = `${mediaGenerationPrefix(asset.id, current.fencingToken)}/hls/master.m3u8`;
  const oldKey = `${mediaGenerationPrefix(asset.id, old.fencingToken)}/hls/master.m3u8`;
  const master = Buffer.from('#EXTM3U\n#CURRENT\n');
  await admin.putObject(bucket, newKey, master, master.length, {
    'Content-Type': 'application/vnd.apple.mpegurl',
  });
  assert.ok(
    await store.completeJob({
      ...credentials(current),
      variants: [variant(asset, current)],
    }),
  );
  assert.equal(
    (await store.getAssetById(asset.id)).hlsGeneration,
    current.fencingToken,
  );
  assert.equal((await store.getVariantsByAssetId(asset.id)).length, 1);
  // Simulate a slow upload finishing after recovery and a newer publication.
  await admin.putObject(bucket, oldKey, Buffer.from('obsolete output'));
  assert.equal(
    await store.completeJob({
      ...credentials(old),
      variants: [variant(asset, old)],
    }),
    null,
  );
  assert.equal(
    (await store.getAssetById(asset.id)).hlsGeneration,
    current.fencingToken,
  );
  const path = createMediaPlaybackUrl({
    assetId: asset.id,
    generation: current.fencingToken,
    secret: 'local-test-playback-key',
  }).path;
  const delivered = await fetch(`http://media-edge:8080${path}`);
  assert.equal(delivered.status, 200);
  assert.ok(
    Buffer.from(await delivered.arrayBuffer()).equals(master),
    'late worker cannot overwrite published object',
  );
  const tampered = path.replace(
    `/${current.fencingToken}/hls/`,
    `/${old.fencingToken}/hls/`,
  );
  assert.equal(
    (await fetch(`http://media-edge:8080${tampered}`)).status,
    403,
    'generation bound to signature',
  );
  const failing = await store.claimNextJob({
    workerId: 'failure-worker',
    leaseMs: 90000,
  });
  assert.ok(failing);
  const failed = await store.failJob({
    ...credentials(failing),
    retryable: false,
    errorMessage: 'secret-object-path',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorMessage, 'Media processing failed');
  assert.equal(
    (await store.getAssetById(asset.id)).status,
    'ready',
    'failure preserves previous publication',
  );
  const fresh = await store.createAsset({
    ...input,
    originObjectKey: 'exhaustion',
  });
  await store.enqueueJob({
    assetId: fresh.id,
    jobType: 'adaptive_hls',
    maxAttempts: 1,
  });
  const exhausted = await store.claimNextJob({
    workerId: 'crashed',
    leaseMs: 90000,
  });
  await expire(exhausted.id);
  await store.recoverExpiredJobs();
  assert.equal((await store.getAssetById(fresh.id)).status, 'failed');
  assert.equal(
    await store.claimNextJob({ workerId: 'next', leaseMs: 90000 }),
    null,
  );
  const deadline = await store.createAsset({
    ...input,
    originObjectKey: 'deadline',
  });
  await store.enqueueJob({ assetId: deadline.id, jobType: 'adaptive_hls' });
  const short = await store.claimNextJob({ workerId: 'short', leaseMs: 90000 });
  await db.query(`CREATE SEQUENCE media_platform.publication_probe; CREATE FUNCTION media_platform.slow_publication() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('media_platform.publication_probe'); PERFORM pg_sleep(0.75); RETURN NEW; END $$;
    CREATE TRIGGER slow_publication BEFORE INSERT ON media_platform.variants
    FOR EACH ROW EXECUTE FUNCTION media_platform.slow_publication()`);
  await db.query(
    "UPDATE media_platform.jobs SET lease_expires_at=clock_timestamp()+INTERVAL '500 milliseconds' WHERE id=$1",
    [short.id],
  );
  assert.equal(
    await store.completeJob({
      ...credentials(short),
      variants: [variant(deadline, short)],
    }),
    null,
    'expiry during publication rolls back',
  );
  assert.equal(
    (await db.query('SELECT is_called FROM media_platform.publication_probe'))
      .rows[0].is_called,
    true,
    'deadline passes inside insertion, not before it',
  );
  assert.equal((await store.getAssetById(deadline.id)).hlsGeneration, null);
  assert.deepEqual(await store.getVariantsByAssetId(deadline.id), []);
  const count = await db.query(
    'SELECT count(*)::int AS n FROM media_platform.variants WHERE asset_id=$1',
    [deadline.id],
  );
  assert.equal(count.rows[0].n, 0, 'no partial publication rows committed');
  await db.query(
    'DROP TRIGGER slow_publication ON media_platform.variants; DROP FUNCTION media_platform.slow_publication()',
  );
  const legacy = await store.createAsset({
    ...input,
    originObjectKey: 'legacy-unleased',
  });
  const abandoned = await store.enqueueJob({
    assetId: legacy.id,
    jobType: 'adaptive_hls',
  });
  await db.query(
    "UPDATE media_platform.jobs SET status='processing',attempts=1,lease_expires_at=NULL,lease_owner=NULL WHERE id=$1",
    [abandoned.id],
  );
  await store.recoverExpiredJobs();
  assert.equal(
    (await store.getJobsForAsset(org, legacy.id))[0].status,
    'queued',
    'unleased legacy processing job recovers',
  );
  assert.equal((await store.getAssetById(legacy.id)).status, 'uploaded');
  await (await import('./worker-lifecycle.mjs')).verifyWorkerLifecycle();
  console.log(
    'PostgreSQL fencing, tenant scoping, concurrent jobs, failure recovery and private-origin stale publication: passed',
  );
} catch (error) {
  console.error(
    error?.code === 'ERR_ASSERTION'
      ? `Media job assertion failed: ${error.message}`
      : `Media job integration failed (${error?.code ?? 'unknown'})`,
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
