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
  UpdateMediaAssetStatusInput,
  UpdateMediaVariantStatusInput,
  UpsertMediaVariantInput,
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
      `
        INSERT INTO media_platform.assets (
          organization_id,
          uploaded_by,
          original_filename,
          mime_type,
          size_bytes,
          origin_bucket,
          origin_object_key
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
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

    return mapAsset(result.rows[0]!);
  }

  async getAssetById(assetId: string): Promise<MediaAsset | null> {
    const result = await db.query<AssetRow>(
      `
        SELECT *
        FROM media_platform.assets
        WHERE id = $1
        LIMIT 1
      `,
      [assetId],
    );

    const row = result.rows[0];
    return row ? mapAsset(row) : null;
  }

  async updateAssetStatus(
    input: UpdateMediaAssetStatusInput,
  ): Promise<MediaAsset | null> {
    const result = await db.query<AssetRow>(
      `
        UPDATE media_platform.assets
        SET
          status = $2,
          error_code = $3,
          error_message = $4,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        input.assetId,
        input.status,
        input.errorCode ?? null,
        input.errorMessage ?? null,
      ],
    );

    const row = result.rows[0];
    return row ? mapAsset(row) : null;
  }

  async upsertVariant(
    input: UpsertMediaVariantInput,
  ): Promise<MediaVariant> {
    const result = await db.query<VariantRow>(
      `
        INSERT INTO media_platform.variants (
          asset_id,
          kind,
          width,
          height,
          bitrate_bps,
          codec,
          container,
          bucket,
          object_key,
          size_bytes,
          status
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11
        )
        ON CONFLICT (bucket, object_key)
        DO UPDATE SET
          asset_id = EXCLUDED.asset_id,
          kind = EXCLUDED.kind,
          width = EXCLUDED.width,
          height = EXCLUDED.height,
          bitrate_bps = EXCLUDED.bitrate_bps,
          codec = EXCLUDED.codec,
          container = EXCLUDED.container,
          size_bytes = EXCLUDED.size_bytes,
          status = EXCLUDED.status,
          updated_at = NOW()
        RETURNING *
      `,
      [
        input.assetId,
        input.kind,
        input.width ?? null,
        input.height ?? null,
        input.bitrateBps ?? null,
        input.codec ?? null,
        input.container ?? null,
        input.bucket,
        input.objectKey,
        input.sizeBytes ?? null,
        input.status,
      ],
    );

    return mapVariant(result.rows[0]!);
  }

  async getVariantById(
    variantId: string,
  ): Promise<MediaVariant | null> {
    const result = await db.query<VariantRow>(
      `
        SELECT *
        FROM media_platform.variants
        WHERE id = $1
        LIMIT 1
      `,
      [variantId],
    );

    const row = result.rows[0];
    return row ? mapVariant(row) : null;
  }

  async getVariantsByAssetId(
    assetId: string,
  ): Promise<MediaVariant[]> {
    const result = await db.query<VariantRow>(
      `
        SELECT *
        FROM media_platform.variants
        WHERE asset_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [assetId],
    );

    return result.rows.map(mapVariant);
  }

  async updateVariantStatus(
    input: UpdateMediaVariantStatusInput,
  ): Promise<MediaVariant | null> {
    const result = await db.query<VariantRow>(
      `
        UPDATE media_platform.variants
        SET
          status = $2,
          size_bytes = COALESCE($3, size_bytes),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        input.variantId,
        input.status,
        input.sizeBytes ?? null,
      ],
    );

    const row = result.rows[0];
    return row ? mapVariant(row) : null;
  }

  async enqueueJob(input: CreateMediaJobInput): Promise<MediaJob> {
    const result = await db.query<JobRow>(
      `
        INSERT INTO media_platform.jobs (
          asset_id,
          job_type,
          priority,
          max_attempts,
          available_at
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [
        input.assetId,
        input.jobType,
        input.priority ?? 100,
        input.maxAttempts ?? 3,
        input.availableAt ?? new Date(),
      ],
    );

    return mapJob(result.rows[0]!);
  }

  async claimNextJob(
    input: ClaimMediaJobInput,
  ): Promise<MediaJob | null> {
    const leaseMs = Math.max(1_000, Math.floor(input.leaseMs));

    return withTransaction(async (client) => {
      const result = await client.query<JobRow>(
        `
          WITH next_job AS (
            SELECT id
            FROM media_platform.jobs
            WHERE status = 'queued'
              AND available_at <= NOW()
              AND attempts < max_attempts
            ORDER BY priority ASC, available_at ASC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE media_platform.jobs AS job
          SET
            status = 'processing',
            attempts = job.attempts + 1,
            started_at = NOW(),
            completed_at = NULL,
            lease_owner = $1,
            lease_expires_at =
              NOW() + ($2::bigint * INTERVAL '1 millisecond'),
            error_code = NULL,
            error_message = NULL,
            updated_at = NOW()
          FROM next_job
          WHERE job.id = next_job.id
          RETURNING job.*
        `,
        [
          input.workerId,
          leaseMs,
        ],
      );

      const row = result.rows[0];
      return row ? mapJob(row) : null;
    });
  }

  async heartbeatJob(
    input: HeartbeatMediaJobInput,
  ): Promise<MediaJob | null> {
    const leaseMs = Math.max(1_000, Math.floor(input.leaseMs));

    const result = await db.query<JobRow>(
      `
        UPDATE media_platform.jobs
        SET
          lease_expires_at =
            NOW() + ($3::bigint * INTERVAL '1 millisecond'),
          updated_at = NOW()
        WHERE id = $1
          AND status = 'processing'
          AND lease_owner = $2
          AND lease_expires_at > NOW()
        RETURNING *
      `,
      [
        input.jobId,
        input.workerId,
        leaseMs,
      ],
    );

    const row = result.rows[0];
    return row ? mapJob(row) : null;
  }

  async recoverExpiredJobs(): Promise<number> {
    const result = await db.query(
      `
        UPDATE media_platform.jobs
        SET
          status = CASE
            WHEN attempts < max_attempts
              THEN 'queued'
            ELSE 'failed'
          END,
          available_at = CASE
            WHEN attempts < max_attempts
              THEN NOW()
            ELSE available_at
          END,
          started_at = CASE
            WHEN attempts < max_attempts
              THEN NULL
            ELSE started_at
          END,
          completed_at = CASE
            WHEN attempts < max_attempts
              THEN NULL
            ELSE NOW()
          END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_code = 'media_job_lease_expired',
          error_message = 'Worker lease expired before job completion',
          updated_at = NOW()
        WHERE status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= NOW()
      `,
    );

    return result.rowCount ?? 0;
  }

  async completeJob(
    input: CompleteMediaJobInput,
  ): Promise<MediaJob | null> {
    const result = await db.query<JobRow>(
      `
        UPDATE media_platform.jobs
        SET
          status = 'completed',
          completed_at = NOW(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_code = NULL,
          error_message = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'processing'
          AND lease_owner = $2
          AND lease_expires_at > NOW()
        RETURNING *
      `,
      [
        input.jobId,
        input.workerId,
      ],
    );

    const row = result.rows[0];
    return row ? mapJob(row) : null;
  }

  async failJob(
    input: FailMediaJobInput,
  ): Promise<MediaJob | null> {
    const result = await db.query<JobRow>(
      `
        UPDATE media_platform.jobs
        SET
          status = CASE
            WHEN $3::boolean = TRUE
              AND attempts < max_attempts
              THEN 'queued'
            ELSE 'failed'
          END,
          available_at = CASE
            WHEN $3::boolean = TRUE
              AND attempts < max_attempts
              THEN NOW() + INTERVAL '30 seconds'
            ELSE available_at
          END,
          started_at = CASE
            WHEN $3::boolean = TRUE
              AND attempts < max_attempts
              THEN NULL
            ELSE started_at
          END,
          completed_at = CASE
            WHEN $3::boolean = TRUE
              AND attempts < max_attempts
              THEN NULL
            ELSE NOW()
          END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_code = $4,
          error_message = $5,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'processing'
          AND lease_owner = $2
          AND lease_expires_at > NOW()
        RETURNING *
      `,
      [
        input.jobId,
        input.workerId,
        input.retryable ?? false,
        input.errorCode ?? null,
        input.errorMessage ?? null,
      ],
    );

    const row = result.rows[0];
    return row ? mapJob(row) : null;
  }

}
