import type {
  ClaimMediaJobInput,
  CompleteMediaJobInput,
  CreateMediaAssetInput,
  CreateMediaJobInput,
  FailMediaJobInput,
  HeartbeatMediaJobInput,
  MediaAsset,
  MediaJob,
  MediaVariant,
  UpdateMediaAssetStatusInput,
  UpdateMediaVariantStatusInput,
  UpsertMediaVariantInput,
} from './types.js';

export interface MediaPlatformStore {
  // ----------------------------------------------------------
  // Assets
  // ----------------------------------------------------------

  createAsset(input: CreateMediaAssetInput): Promise<MediaAsset>;

  getAssetById(assetId: string): Promise<MediaAsset | null>;

  updateAssetStatus(
    input: UpdateMediaAssetStatusInput,
  ): Promise<MediaAsset | null>;

  // ----------------------------------------------------------
  // Variants
  // ----------------------------------------------------------

  upsertVariant(
    input: UpsertMediaVariantInput,
  ): Promise<MediaVariant>;

  getVariantById(
    variantId: string,
  ): Promise<MediaVariant | null>;

  getVariantsByAssetId(
    assetId: string,
  ): Promise<MediaVariant[]>;

  updateVariantStatus(
    input: UpdateMediaVariantStatusInput,
  ): Promise<MediaVariant | null>;

  // ----------------------------------------------------------
  // Processing jobs
  // ----------------------------------------------------------

  enqueueJob(input: CreateMediaJobInput): Promise<MediaJob>;

  /**
   * Atomically claims the next available job.
   *
   * PostgreSQL implementations should use:
   *
   *   FOR UPDATE SKIP LOCKED
   *
   * so multiple workers can safely claim jobs without
   * processing the same job simultaneously.
   */
  claimNextJob(
    input: ClaimMediaJobInput,
  ): Promise<MediaJob | null>;

  heartbeatJob(
    input: HeartbeatMediaJobInput,
  ): Promise<MediaJob | null>;

  recoverExpiredJobs(): Promise<number>;

  completeJob(
    input: CompleteMediaJobInput,
  ): Promise<MediaJob | null>;

  /**
   * Records a processing failure.
   *
   * Retryable jobs may return to the queued state when attempts
   * remain. Non-retryable jobs become permanently failed.
   */
  failJob(
    input: FailMediaJobInput,
  ): Promise<MediaJob | null>;
}
