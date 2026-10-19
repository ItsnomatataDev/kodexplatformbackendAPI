import { mediaGenerationPrefix } from './object-keys.js';
import { db } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';

import type { MediaPlatformStore } from './store.js';
import type {
  ClaimMediaJobInput,
  CompleteMediaJobInput,
  CreateMediaAssetInput,
  CreateMediaJobInput,
  FailMediaJobInput,
  HeartbeatMediaJobInput,
  MediaAsset,
  MediaAssetStatus,
  MediaJob,
  MediaJobStatus,
  MediaJobType,
  MediaVariant,
  MediaVariantStatus,
} from './types.js';

type AssetRow = {
  id: string;
  organization_id: string;
  uploaded_by: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: string;
  origin_bucket: string;
  origin_object_key: string;
  status: MediaAssetStatus;
  fencing_token: string;
  hls_generation: string | null;
  playback_generation: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type VariantRow = {
  id: string;
  asset_id: string;
  kind: string;
  width: number | null;
  height: number | null;
  bitrate_bps: number | null;
  codec: string | null;
  container: string | null;
  bucket: string;
  object_key: string;
  size_bytes: string | null;
  status: MediaVariantStatus;
  generation: string | null;
  created_at: Date;
  updated_at: Date;
};

type JobRow = {
  id: string;
  asset_id: string;
  job_type: MediaJobType;
  status: MediaJobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  fencing_token: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapAsset(row: AssetRow): MediaAsset {
  return {
    id: row.id,
    organizationId: row.organization_id,
    uploadedBy: row.uploaded_by,
    fencingToken: row.fencing_token,
    hlsGeneration: row.hls_generation,
    playbackGeneration: row.playback_generation,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    originBucket: row.origin_bucket,
    originObjectKey: row.origin_object_key,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVariant(row: VariantRow): MediaVariant {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind,
    generation: row.generation,
    width: row.width,
    height: row.height,
    bitrateBps: row.bitrate_bps,
    codec: row.codec,
    container: row.container,
    bucket: row.bucket,
    objectKey: row.object_key,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row: JobRow): MediaJob {
  return {
    id: row.id,
    assetId: row.asset_id,
    jobType: row.job_type,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    fencingToken: row.fencing_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresMediaPlatformStore implements MediaPlatformStore {
  async createAsset(input: CreateMediaAssetInput): Promise<MediaAsset> {
    const result = await db.query<AssetRow>(
      `INSERT INTO media_platform.assets
      (organization_id,uploaded_by,original_filename,mime_type,size_bytes,origin_bucket,origin_object_key)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.organizationId,
        input.uploadedBy ?? null,
        input.originalFilename,
        input.mimeType,
        input.sizeBytes,
        input.originBucket,
        input.originObjectKey,
      ],
    );
    return mapAsset(result.rows[0]);
  }

  async createAssetAndJob(input: CreateMediaAssetInput): Promise<MediaAsset> {
    return withTransaction(async (client) => {
      const result = await client.query<AssetRow>(
        `INSERT INTO media_platform.assets
        (organization_id,uploaded_by,original_filename,mime_type,size_bytes,origin_bucket,origin_object_key)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (origin_bucket,origin_object_key) DO UPDATE SET updated_at=media_platform.assets.updated_at
        WHERE media_platform.assets.organization_id=EXCLUDED.organization_id AND media_platform.assets.status <> 'deleted'
        RETURNING *`,
        [
          input.organizationId,
          input.uploadedBy ?? null,
          input.originalFilename,
          input.mimeType,
          input.sizeBytes,
          input.originBucket,
          input.originObjectKey,
        ],
      );
      if (!result.rows[0]) throw new Error('media_source_conflict');
      const asset = mapAsset(result.rows[0]);
      // Repeated source registration is idempotent, including terminal failures.
      await client.query(
        `INSERT INTO media_platform.jobs(asset_id,job_type)
        SELECT $1,'adaptive_hls' WHERE NOT EXISTS(SELECT 1 FROM media_platform.jobs WHERE asset_id=$1)`,
        [asset.id],
      );
      return asset;
    });
  }

  async getAssetById(assetId: string): Promise<MediaAsset | null> {
    const r = await db.query<AssetRow>(
      'SELECT * FROM media_platform.assets WHERE id=$1',
      [assetId],
    );
    return r.rows[0] ? mapAsset(r.rows[0]) : null;
  }
  async getAssetForOrganization(
    organizationId: string,
    assetId: string,
  ): Promise<MediaAsset | null> {
    const r = await db.query<AssetRow>(
      `SELECT * FROM media_platform.assets
      WHERE id=$1 AND organization_id=$2 AND status <> 'deleted'`,
      [assetId, organizationId],
    );
    return r.rows[0] ? mapAsset(r.rows[0]) : null;
  }
  async getVariantById(id: string): Promise<MediaVariant | null> {
    const r = await db.query<VariantRow>(
      'SELECT * FROM media_platform.variants WHERE id=$1',
      [id],
    );
    return r.rows[0] ? mapVariant(r.rows[0]) : null;
  }
  async getVariantsByAssetId(assetId: string): Promise<MediaVariant[]> {
    const r = await db.query<VariantRow>(
      `SELECT v.* FROM media_platform.variants v JOIN media_platform.assets a ON a.id=v.asset_id
      WHERE a.id=$1 AND a.status <> 'deleted' AND v.status='ready'
      AND v.generation IN (a.hls_generation,a.playback_generation) ORDER BY v.kind`,
      [assetId],
    );
    return r.rows.map(mapVariant);
  }
  async getJobsForAsset(
    organizationId: string,
    assetId: string,
  ): Promise<MediaJob[]> {
    const r = await db.query<JobRow>(
      `SELECT j.* FROM media_platform.jobs j JOIN media_platform.assets a ON a.id=j.asset_id
      WHERE a.id=$1 AND a.organization_id=$2 AND a.status <> 'deleted' ORDER BY j.created_at DESC,j.id LIMIT 20`,
      [assetId, organizationId],
    );
    return r.rows.map(mapJob);
  }
  async enqueueForOrganization(
    organizationId: string,
    assetId: string,
  ): Promise<MediaJob | null> {
    return withTransaction(async (client) => {
      const asset = await client.query<AssetRow>(
        `SELECT * FROM media_platform.assets
        WHERE id=$1 AND organization_id=$2 AND status <> 'deleted' FOR UPDATE`,
        [assetId, organizationId],
      );
      if (!asset.rows[0]) return null;
      const active = await client.query<JobRow>(
        `SELECT * FROM media_platform.jobs
        WHERE asset_id=$1 AND job_type='adaptive_hls' AND status IN ('queued','processing') LIMIT 1`,
        [assetId],
      );
      if (active.rows[0]) return mapJob(active.rows[0]);
      const r = await client.query<JobRow>(
        `INSERT INTO media_platform.jobs(asset_id,job_type) VALUES($1,'adaptive_hls') RETURNING *`,
        [assetId],
      );
      if (!asset.rows[0].hls_generation)
        await client.query(
          `UPDATE media_platform.assets SET status='uploaded',error_code=NULL,error_message=NULL WHERE id=$1`,
          [assetId],
        );
      return mapJob(r.rows[0]);
    });
  }
  async enqueueJob(input: CreateMediaJobInput): Promise<MediaJob> {
    return withTransaction(async (client) => {
      await client.query(
        'SELECT id FROM media_platform.assets WHERE id=$1 FOR UPDATE',
        [input.assetId],
      );
      const r = await client.query<JobRow>(
        `INSERT INTO media_platform.jobs(asset_id,job_type,priority,max_attempts,available_at)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [
          input.assetId,
          input.jobType,
          input.priority ?? 100,
          input.maxAttempts ?? 3,
          input.availableAt ?? new Date(),
        ],
      );
      return mapJob(r.rows[0]);
    });
  }
  async claimNextJob(input: ClaimMediaJobInput): Promise<MediaJob | null> {
    return withTransaction(async (client) => {
      const next = await client.query<{
        id: string;
        asset_id: string;
      }>(`SELECT j.id,j.asset_id FROM media_platform.jobs j
      JOIN media_platform.assets a ON a.id=j.asset_id
      WHERE j.status='queued'
        AND j.job_type IN ('playback_mp4', 'adaptive_hls')
        AND j.available_at <= clock_timestamp()
        AND j.attempts < j.max_attempts
        AND a.status <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM media_platform.jobs running
          WHERE running.asset_id=j.asset_id
            AND running.status='processing'
        )
      ORDER BY j.priority,j.available_at,j.created_at,j.id
      LIMIT 1 FOR UPDATE OF a,j SKIP LOCKED`);

      if (!next.rows[0]) return null;

      const r = await client.query<JobRow>(
        `UPDATE media_platform.jobs
       SET status='processing',
           attempts=attempts+1,
           started_at=clock_timestamp(),
           completed_at=NULL,
           lease_owner=$2,
           lease_expires_at=clock_timestamp()+($3::bigint*INTERVAL '1 millisecond'),
           fencing_token=nextval('media_platform.fencing_tokens'),
           error_code=NULL,
           error_message=NULL,
           updated_at=clock_timestamp()
       WHERE id=$1 RETURNING *`,
        [
          next.rows[0].id,
          input.workerId,
          Math.max(1000, Math.floor(input.leaseMs)),
        ],
      );

      await client.query(
        `UPDATE media_platform.assets
       SET fencing_token=$2,
           status=CASE
             WHEN hls_generation IS NULL AND playback_generation IS NULL
             THEN 'processing'
             ELSE status
           END,
           error_code=NULL,
           error_message=NULL,
           updated_at=clock_timestamp()
       WHERE id=$1`,
        [next.rows[0].asset_id, r.rows[0].fencing_token],
      );

      return mapJob(r.rows[0]);
    });
  }
  async heartbeatJob(input: HeartbeatMediaJobInput): Promise<MediaJob | null> {
    const r = await db.query<JobRow>(
      `UPDATE media_platform.jobs j SET
      lease_expires_at=clock_timestamp()+($4::bigint*INTERVAL '1 millisecond'),updated_at=clock_timestamp()
      WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND status='processing' AND lease_expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM media_platform.assets a WHERE a.id=j.asset_id AND a.fencing_token=j.fencing_token AND a.status <> 'deleted')
      RETURNING *`,
      [
        input.jobId,
        input.workerId,
        input.fencingToken,
        Math.max(1000, Math.floor(input.leaseMs)),
      ],
    );
    return r.rows[0] ? mapJob(r.rows[0]) : null;
  }
  async completeJob(input: CompleteMediaJobInput): Promise<MediaJob | null> {
    try {
      return await withTransaction(async (client) => {
        const a = await client.query<AssetRow>(
          `SELECT a.* FROM media_platform.assets a JOIN media_platform.jobs j ON j.asset_id=a.id
          WHERE j.id=$1 FOR UPDATE OF a`,
          [input.jobId],
        );
        const asset = a.rows[0];
        if (
          !asset ||
          asset.status === 'deleted' ||
          asset.fencing_token !== input.fencingToken
        )
          return null;
        const j = await client.query<JobRow>(
          `SELECT * FROM media_platform.jobs WHERE id=$1 AND lease_owner=$2
          AND fencing_token=$3 AND status='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE`,
          [input.jobId, input.workerId, input.fencingToken],
        );
        const job = j.rows[0];
        if (!job) return null;
        const prefix = mediaGenerationPrefix(asset.id, input.fencingToken);
        if (
          !input.variants.length ||
          !['adaptive_hls', 'playback_mp4'].includes(job.job_type)
        )
          throw new Error('media_publication_invalid');
        for (const variant of input.variants) {
          const suffix =
            job.job_type === 'adaptive_hls' &&
            /^hls_(1080p|720p|480p)$/.test(variant.kind)
              ? `/hls/${variant.kind.slice(4)}/index.m3u8`
              : job.job_type === 'playback_mp4' &&
                  variant.kind === 'playback_mp4'
                ? '/playback/playback.mp4'
                : null;
          if (
            !suffix ||
            variant.assetId !== asset.id ||
            variant.bucket !== asset.origin_bucket ||
            variant.objectKey !== prefix + suffix ||
            variant.status !== 'ready'
          )
            throw new Error('media_publication_invalid');
          await client.query(
            `INSERT INTO media_platform.variants
            (asset_id,kind,width,height,bitrate_bps,codec,container,bucket,object_key,size_bytes,status,generation)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready',$11)`,
            [
              asset.id,
              variant.kind,
              variant.width,
              variant.height,
              variant.bitrateBps,
              variant.codec,
              variant.container,
              variant.bucket,
              variant.objectKey,
              variant.sizeBytes,
              input.fencingToken,
            ],
          );
        }
        // A publication pointer and the ready variants commit together. Old objects remain immutable.
        const column =
          job.job_type === 'adaptive_hls'
            ? 'hls_generation'
            : 'playback_generation';
        await client.query(
          `UPDATE media_platform.assets SET ${column}=$2,status='ready',error_code=NULL,error_message=NULL,
          updated_at=clock_timestamp() WHERE id=$1`,
          [asset.id, input.fencingToken],
        );
        const done = await client.query<JobRow>(
          `UPDATE media_platform.jobs SET status='completed',completed_at=clock_timestamp(),
          lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2
          AND fencing_token=$3 AND lease_expires_at>clock_timestamp() RETURNING *`,
          [input.jobId, input.workerId, input.fencingToken],
        );
        // If the deadline passed during writes, roll back ALL publication changes.
        if (!done.rows[0]) throw new Error('media_job_lease_lost');
        return mapJob(done.rows[0]);
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'media_job_lease_lost')
        return null;
      throw error;
    }
  }
  async failJob(input: FailMediaJobInput): Promise<MediaJob | null> {
    return withTransaction(async (client) => {
      const a = await client.query<AssetRow>(
        `SELECT a.* FROM media_platform.assets a JOIN media_platform.jobs j ON j.asset_id=a.id
        WHERE j.id=$1 FOR UPDATE OF a`,
        [input.jobId],
      );
      if (
        !a.rows[0] ||
        a.rows[0].fencing_token !== input.fencingToken ||
        a.rows[0].status === 'deleted'
      )
        return null;
      const r = await client.query<JobRow>(
        `UPDATE media_platform.jobs SET
        status=CASE WHEN $4 AND attempts<max_attempts THEN 'queued' ELSE 'failed' END,
        available_at=CASE WHEN $4 AND attempts<max_attempts THEN clock_timestamp()+INTERVAL '30 seconds' ELSE available_at END,
        completed_at=CASE WHEN $4 AND attempts<max_attempts THEN NULL ELSE clock_timestamp() END,
        lease_owner=NULL,lease_expires_at=NULL,error_code='media_processing_failed',error_message='Media processing failed',updated_at=clock_timestamp()
        WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND status='processing' AND lease_expires_at>clock_timestamp() RETURNING *`,
        [
          input.jobId,
          input.workerId,
          input.fencingToken,
          input.retryable ?? false,
        ],
      );
      if (!r.rows[0]) return null;
      await client.query(
        `UPDATE media_platform.assets SET status=CASE
        WHEN hls_generation IS NOT NULL OR playback_generation IS NOT NULL THEN 'ready'
        WHEN $2='queued' THEN 'uploaded' ELSE 'failed' END,error_code='media_processing_failed',error_message=NULL,
        updated_at=clock_timestamp() WHERE id=$1`,
        [a.rows[0].id, r.rows[0].status],
      );
      return mapJob(r.rows[0]);
    });
  }
  async recoverExpiredJobs(): Promise<number> {
    return withTransaction(async (client) => {
      const assets = await client.query<{
        id: string;
      }>(`SELECT a.id FROM media_platform.assets a WHERE EXISTS
        (SELECT 1 FROM media_platform.jobs j WHERE j.asset_id=a.id AND j.status='processing' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp()))
        ORDER BY a.id LIMIT 100 FOR UPDATE SKIP LOCKED`);
      let count = 0;
      for (const asset of assets.rows) {
        const r = await client.query<JobRow>(
          `UPDATE media_platform.jobs SET
          status=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'failed' END,
          available_at=clock_timestamp(),completed_at=CASE WHEN attempts<max_attempts THEN NULL ELSE clock_timestamp() END,
          lease_owner=NULL,lease_expires_at=NULL,error_code='media_job_lease_expired',error_message=NULL,updated_at=clock_timestamp()
          WHERE asset_id=$1 AND status='processing' AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *`,
          [asset.id],
        );
        count += r.rowCount ?? 0;
        if (r.rows.length)
          await client.query(
            `UPDATE media_platform.assets SET status=CASE
          WHEN hls_generation IS NOT NULL OR playback_generation IS NOT NULL THEN 'ready'
          WHEN $2 THEN 'uploaded' ELSE 'failed' END,error_code='media_job_lease_expired',error_message=NULL
          WHERE id=$1 AND status <> 'deleted'`,
            [asset.id, r.rows.some((j) => j.status === 'queued')],
          );
      }
      return count;
    });
  }
}
