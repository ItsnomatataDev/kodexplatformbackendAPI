import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { logger } from '../config/logger.js';
import { db } from '../db/pool.js';
import { MinioFileStorage } from '../files/minio-storage.js';

import { MediaVariantDrafts } from './processing/drafts.js';
import { MediaJobService } from './jobs.js';
import { PostgresMediaPlatformStore } from './postgres-store.js';
import { processAdaptiveHls } from './processing/adaptive-hls.js';
import { processPlaybackMp4 } from './processing/playback-mp4.js';
import { stageMediaSource } from './processing/source.js';
import type { MediaJob } from './types.js';

const POLL_INTERVAL_MS = 2_000;
const JOB_TIMEOUT_MS = 30 * 60_000;

const LEASE_MS = 90_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECOVERY_INTERVAL_MS = 30_000;

const WORKER_ID =
  `media-worker:${hostname()}:${process.pid}:${randomUUID()}`;

const stop = new AbortController();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (!stop.signal.aborted) {
      logger.info(
        {
          signal,
          workerId: WORKER_ID,
        },
        'media.worker.shutdown_requested',
      );

      stop.abort();
    }
  });
}

const storage = new MinioFileStorage();
const store = new PostgresMediaPlatformStore();

const jobs = new MediaJobService(
  store,
  {
    workerId: WORKER_ID,
    leaseMs: LEASE_MS,
  },
);

function assertImplementedJob(job: MediaJob): void {
  switch (job.jobType) {
    case 'playback_mp4':
    case 'adaptive_hls':
      return;

    case 'thumbnail':
    case 'metadata':
      throw new Error(
        `media_job_type_not_implemented:${job.jobType}`,
      );

    default: {
      const exhaustive: never = job.jobType;

      throw new Error(
        `media_job_type_unknown:${String(exhaustive)}`,
      );
    }
  }
}

function startHeartbeat(
  job: MediaJob,
  jobController: AbortController,
): () => Promise<void> {
  let stopped = false;

  const loop = (async () => {
    while (
      !stopped &&
      !stop.signal.aborted &&
      !jobController.signal.aborted
    ) {
      await delay(
        HEARTBEAT_INTERVAL_MS,
        undefined,
        { signal: jobController.signal },
      ).catch(() => {});

      if (
        stopped ||
        stop.signal.aborted ||
        jobController.signal.aborted
      ) {
        break;
      }

      try {
        const heartbeat = await jobs.heartbeat(job);

        if (heartbeat === null) {
          logger.error(
            {
              jobId: job.id,
              assetId: job.assetId,
              workerId: WORKER_ID,
            },
            'media.worker.lease_lost',
          );

          jobController.abort(
            new Error('media_job_lease_lost'),
          );

          break;
        }

        logger.debug(
          {
            jobId: job.id,
            assetId: job.assetId,
            workerId: WORKER_ID,
            leaseExpiresAt: heartbeat.leaseExpiresAt,
          },
          'media.worker.heartbeat',
        );
      } catch (error) {
        // Stop publishing when ownership cannot be renewed. Database fencing
        // and immutable generation prefixes prevent stale publication.
        jobController.abort(new Error('media_job_lease_lost'));
        logger.warn(
          {
            jobId: job.id,
            assetId: job.assetId,
            workerId: WORKER_ID,
            code: 'heartbeat_failed',
          },
          'media.worker.heartbeat_error',
        );
      }
    }
  })();

  return async () => {
    stopped = true;
    await loop.catch(() => {});
  };
}

async function processJob(job: MediaJob): Promise<void> {
  const started = Date.now();

  /*
   * Reject unsupported work before loading/staging media.
   * This prevents unnecessary MinIO reads and temporary-file work.
   */
  assertImplementedJob(job);

  const asset = await store.getAssetById(job.assetId);

  if (asset === null) {
    throw new Error(`media_asset_not_found:${job.assetId}`);
  }

  logger.info(
    {
      jobId: job.id,
      assetId: asset.id,
      jobType: job.jobType,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      workerId: WORKER_ID,
      leaseExpiresAt: job.leaseExpiresAt,
    },
    'media.worker.job_started',
  );

  const drafts = new MediaVariantDrafts(job.fencingToken);

  const jobController = new AbortController();

  const timeout = setTimeout(
    () => {
      jobController.abort(
        new Error('media_job_timeout'),
      );
    },
    JOB_TIMEOUT_MS,
  );

  const abortFromShutdown = () => {
    jobController.abort(
      new Error('media_worker_shutdown'),
    );
  };

  stop.signal.addEventListener(
    'abort',
    abortFromShutdown,
    { once: true },
  );

  const stopHeartbeat = startHeartbeat(
    job,
    jobController,
  );

  let source: Awaited<
    ReturnType<typeof stageMediaSource>
  > | null = null;

  try {
    source = await stageMediaSource(
      storage,
      asset.originBucket,
      asset.originObjectKey,
      jobController.signal,
    );

    switch (job.jobType) {
      case 'playback_mp4': {
        const variant = await processPlaybackMp4({
          asset,
          generation: job.fencingToken,
          source,
          storage,
          store: drafts,
          signal: jobController.signal,
        });

        logger.info(
          {
            jobId: job.id,
            assetId: asset.id,
            variantId: variant.id,
            width: variant.width,
            height: variant.height,
            codec: variant.codec,
            sizeBytes: variant.sizeBytes,
            durationMs: Date.now() - started,
          },
          'media.worker.playback_ready',
        );

        break;
      }

      case 'adaptive_hls': {
        const result = await processAdaptiveHls({
          asset,
          generation: job.fencingToken,
          source,
          storage,
          store: drafts,
          signal: jobController.signal,
        });

        logger.info(
          {
            jobId: job.id,
            assetId: asset.id,
            masterObjectKey: result.masterObjectKey,
            renditionCount: result.renditionCount,
            variants: result.variants.map((variant) => ({
              id: variant.id,
              kind: variant.kind,
              width: variant.width,
              height: variant.height,
              bitrateBps: variant.bitrateBps,
              sizeBytes: variant.sizeBytes,
            })),
            durationMs: Date.now() - started,
          },
          'media.worker.hls_ready',
        );

        break;
      }

      default:
        throw new Error(
          `media_job_type_not_implemented:${job.jobType}`,
        );
    }

    /*
     * Do not complete after an abort. In particular, a worker
     * whose lease was lost must never attempt finalization.
     */
    if (jobController.signal.aborted) {
      const reason = jobController.signal.reason;

      if (reason instanceof Error) {
        throw reason;
      }

      throw new Error('media_job_aborted');
    }

    const completed = await jobs.complete(job, drafts.ready());

    if (completed === null) {
      throw new Error(
        `media_job_lease_lost:${job.id}`,
      );
    }

    logger.info(
      {
        jobId: job.id,
        assetId: asset.id,
        jobType: job.jobType,
        attempts: completed.attempts,
        workerId: WORKER_ID,
        durationMs: Date.now() - started,
      },
      'media.worker.job_completed',
    );
  } finally {
    clearTimeout(timeout);

    stop.signal.removeEventListener(
      'abort',
      abortFromShutdown,
    );

    jobController.abort();

    await stopHeartbeat();

    if (source !== null) {
      await source.cleanup().catch((error) => {
        logger.warn(
          {
            jobId: job.id,
            assetId: job.assetId,
            error,
          },
          'media.worker.cleanup_failed',
        );
      });
    }
  }
}

function isLeaseLostError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (
      error.message === 'media_job_lease_lost' ||
      error.message.startsWith('media_job_lease_lost:')
    )
  );
}

function isRetryableError(error: unknown): boolean {
  if (
    stop.signal.aborted ||
    (
      error instanceof Error &&
      error.message === 'media_worker_shutdown'
    )
  ) {
    return true;
  }

  if (!(error instanceof Error)) {
    return true;
  }

  const permanentPrefixes = [
    'media_asset_not_found:',
    'media_job_type_not_implemented:',
    'media_job_type_unknown:',
  ];

  if (
    permanentPrefixes.some(
      (prefix) => error.message.startsWith(prefix),
    )
  ) {
    return false;
  }

  const permanentErrors = new Set([
    'media_source_not_found',
    'media_source_too_large',
    'media_source_size_mismatch',
    'media_source_has_no_video',
    'media_storage_head_not_supported',
    'media_storage_stream_not_supported',
    'media_storage_stream_upload_not_supported',
    'media_playback_output_invalid',
    'media_playback_output_not_video',
  ]);

  if (permanentErrors.has(error.message)) {
    return false;
  }

  return true;
}

function isAssetFatalError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  /*
   * These failures mean the source asset itself cannot currently
   * be processed as valid media. Derivative-specific failures do
   * not belong here.
   */
  const sourceFatalErrors = new Set([
    'media_source_not_found',
    'media_source_too_large',
    'media_source_size_mismatch',
    'media_source_has_no_video',
  ]);

  return sourceFatalErrors.has(error.message);
}

async function handleJobFailure(
  job: MediaJob,
  error: unknown,
): Promise<void> {
  const err = error instanceof Error
    ? error
    : new Error(String(error));

  /*
   * Once ownership has been lost, this worker is fenced out.
   * It must not attempt fail/retry transitions on the job.
   */
  if (isLeaseLostError(error)) {
    logger.warn(
      {
        jobId: job.id,
        assetId: job.assetId,
        jobType: job.jobType,
        workerId: WORKER_ID,
        errorName: err.name,
        errorCode: 'media_processing_failed',
      },
      'media.worker.lease_lost_failure_ignored',
    );

    return;
  }

  const retryable = isRetryableError(error);

  const failedJob = await jobs.fail(
    job,
    error,
    retryable,
  );

  if (failedJob === null) {
    logger.error(
      {
        jobId: job.id,
        assetId: job.assetId,
        jobType: job.jobType,
        workerId: WORKER_ID,
        errorName: err.name,
        errorCode: 'media_processing_failed',
      },
      'media.worker.failure_state_conflict',
    );

    return;
  }

  logger.warn(
    {
      jobId: job.id,
      assetId: job.assetId,
      jobType: job.jobType,
      attempt: failedJob.attempts,
      maxAttempts: failedJob.maxAttempts,
      retryable,
      resultingStatus: failedJob.status,
      nextAvailableAt:
        failedJob.status === 'queued'
          ? failedJob.availableAt
          : null,
      assetFatal: isAssetFatalError(error),
      workerId: WORKER_ID,
      errorName: err.name,
      errorCode: 'media_processing_failed',
    },
    failedJob.status === 'queued'
      ? 'media.worker.job_retry_scheduled'
      : 'media.worker.job_failed',
  );
}

async function recoverExpiredJobs(): Promise<void> {
  try {
    const recovered = await jobs.recoverExpired();

    if (recovered > 0) {
      logger.warn(
        {
          workerId: WORKER_ID,
          recovered,
        },
        'media.worker.expired_jobs_recovered',
      );
    }
  } catch (error) {
    logger.error(
      {
        workerId: WORKER_ID,
        error,
      },
      'media.worker.expired_job_recovery_failed',
    );
  }
}

async function run(): Promise<void> {
  logger.info(
    {
      workerId: WORKER_ID,
      pollIntervalMs: POLL_INTERVAL_MS,
      jobTimeoutMs: JOB_TIMEOUT_MS,
      leaseMs: LEASE_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      recoveryIntervalMs: RECOVERY_INTERVAL_MS,
    },
    'media.worker.started',
  );

  let nextRecoveryAt = 0;

  while (!stop.signal.aborted) {
    let job: MediaJob | null = null;

    try {
      const now = Date.now();

      if (now >= nextRecoveryAt) {
        await recoverExpiredJobs();
        nextRecoveryAt = now + RECOVERY_INTERVAL_MS;
      }

      job = await jobs.claim();

      if (job === null) {
        await delay(
          POLL_INTERVAL_MS,
          undefined,
          { signal: stop.signal },
        ).catch(() => {});

        continue;
      }

      try {
        await processJob(job);
      } catch (error) {
        await handleJobFailure(job, error);
      }
    } catch (error) {
      if (stop.signal.aborted) {
        break;
      }

      const err = error instanceof Error
        ? error
        : new Error(String(error));

      logger.error(
        {
          jobId: job?.id ?? null,
          assetId: job?.assetId ?? null,
          workerId: WORKER_ID,
          errorName: err.name,
          errorCode: 'media_processing_failed',
        },
        'media.worker.loop_error',
      );

      await delay(
        POLL_INTERVAL_MS,
        undefined,
        { signal: stop.signal },
      ).catch(() => {});
    }
  }

  logger.info(
    {
      workerId: WORKER_ID,
    },
    'media.worker.stopped',
  );
}

try {
  await run();
} finally {
  await db.end();
}
