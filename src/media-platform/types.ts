export type MediaAssetStatus =
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted';

export type MediaVariantStatus =
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted';

export type MediaJobType =
  | 'playback_mp4'
  | 'adaptive_hls'
  | 'thumbnail'
  | 'metadata';

export type MediaJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type MediaAsset = {
  id: string;
  organizationId: string;
  uploadedBy: string | null;

  originalFilename: string;
  mimeType: string;
  sizeBytes: number;

  originBucket: string;
  originObjectKey: string;

  status: MediaAssetStatus;

  errorCode: string | null;
  errorMessage: string | null;

  createdAt: Date;
  updatedAt: Date;
};

export type MediaVariant = {
  id: string;
  assetId: string;

  kind: string;

  width: number | null;
  height: number | null;
  bitrateBps: number | null;

  codec: string | null;
  container: string | null;

  bucket: string;
  objectKey: string;

  sizeBytes: number | null;

  status: MediaVariantStatus;

  createdAt: Date;
  updatedAt: Date;
};

export type MediaJob = {
  id: string;
  assetId: string;

  jobType: MediaJobType;
  status: MediaJobStatus;

  priority: number;

  attempts: number;
  maxAttempts: number;

  availableAt: Date;

  startedAt: Date | null;
  completedAt: Date | null;

  leaseOwner: string | null;
  leaseExpiresAt: Date | null;

  errorCode: string | null;
  errorMessage: string | null;

  createdAt: Date;
  updatedAt: Date;
};

export type CreateMediaAssetInput = {
  organizationId: string;
  uploadedBy?: string | null;

  originalFilename: string;
  mimeType: string;
  sizeBytes: number;

  originBucket: string;
  originObjectKey: string;
};

export type CreateMediaJobInput = {
  assetId: string;
  jobType: MediaJobType;

  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
};

export type ClaimMediaJobInput = {
  workerId: string;
  leaseMs: number;
};

export type HeartbeatMediaJobInput = {
  jobId: string;
  workerId: string;
  leaseMs: number;
};

export type CompleteMediaJobInput = {
  jobId: string;
  workerId: string;
};

export type FailMediaJobInput = {
  jobId: string;
  workerId: string;
  errorCode?: string | null;
  errorMessage?: string | null;

  /**
   * When true, the job may be returned to the queue when
   * attempts remain. Otherwise it becomes permanently failed.
   */
  retryable?: boolean;
};

export type UpdateMediaAssetStatusInput = {
  assetId: string;
  status: MediaAssetStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type UpsertMediaVariantInput = {
  assetId: string;
  kind: string;

  width?: number | null;
  height?: number | null;
  bitrateBps?: number | null;

  codec?: string | null;
  container?: string | null;

  bucket: string;
  objectKey: string;

  sizeBytes?: number | null;

  status: MediaVariantStatus;
};

export type UpdateMediaVariantStatusInput = {
  variantId: string;
  status: MediaVariantStatus;
  sizeBytes?: number | null;
};
