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
  UpdateMediaVariantStatusInput,
  UpsertMediaVariantInput,
} from './types.js';

export interface MediaPlatformStore {
  // ----------------------------------------------------------
  // Assets
  // ----------------------------------------------------------

  createAsset(input: CreateMediaAssetInput): Promise<MediaAsset>;

  getAssetById(assetId: string): Promise<MediaAsset | null>;

  getVariantById(
    variantId: string,
  ): Promise<MediaVariant | null>;

  getVariantsByAssetId(
    assetId: string,
  ): Promise<MediaVariant[]>;

  getAssetForOrganization(organizationId: string, assetId: string): Promise<MediaAsset | null>;
  createAssetAndJob(input: CreateMediaAssetInput): Promise<MediaAsset>;
  enqueueForOrganization(organizationId: string, assetId: string): Promise<MediaJob | null>;
  getJobsForAsset(organizationId: string, assetId: string): Promise<MediaJob[]>;

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

/** Processor-local drafts: these operations do not write shared database state. */
export interface MediaVariantDraftStore {
  upsertVariant(input: UpsertMediaVariantInput): Promise<MediaVariant>;
  updateVariantStatus(input: UpdateMediaVariantStatusInput): Promise<MediaVariant | null>;
}
