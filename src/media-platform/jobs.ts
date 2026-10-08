import type { MediaPlatformStore } from './store.js';
import type {
  MediaJob,
  MediaJobType,
} from './types.js';

export type EnqueueMediaJobOptions = {
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
};

export type MediaJobServiceOptions = {
  workerId: string;
  leaseMs: number;
};

export class MediaJobService {
  private readonly workerId: string;
  private readonly leaseMs: number;

  constructor(
    private readonly store: MediaPlatformStore,
    options: MediaJobServiceOptions,
  ) {
    const workerId = options.workerId.trim();

    if (!workerId) {
      throw new Error('media_worker_id_required');
    }

    if (!Number.isFinite(options.leaseMs) || options.leaseMs < 1_000) {
      throw new Error('media_worker_lease_invalid');
    }

    this.workerId = workerId;
    this.leaseMs = Math.floor(options.leaseMs);
  }

  async enqueue(
    assetId: string,
    jobType: MediaJobType,
    options: EnqueueMediaJobOptions = {},
  ): Promise<MediaJob> {
    return this.store.enqueueJob({
      assetId,
      jobType,
      priority: options.priority,
      maxAttempts: options.maxAttempts,
      availableAt: options.availableAt,
    });
  }

  async claim(): Promise<MediaJob | null> {
    return this.store.claimNextJob({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
  }

  async heartbeat(jobId: string): Promise<MediaJob | null> {
    return this.store.heartbeatJob({
      jobId,
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
  }

  async recoverExpired(): Promise<number> {
    return this.store.recoverExpiredJobs();
  }

  async complete(jobId: string): Promise<MediaJob | null> {
    return this.store.completeJob({
      jobId,
      workerId: this.workerId,
    });
  }

  async fail(
    jobId: string,
    error: unknown,
    retryable = false,
  ): Promise<MediaJob | null> {
    const normalized = normalizeJobError(error);

    return this.store.failJob({
      jobId,
      workerId: this.workerId,
      retryable,
      errorCode: normalized.code,
      errorMessage: normalized.message,
    });
  }
}

function normalizeJobError(error: unknown): {
  code: string | null;
  message: string;
} {
  if (error instanceof Error) {
    return {
      code: error.name || null,
      message: error.message || 'Media processing failed',
    };
  }

  if (typeof error === 'string') {
    return {
      code: null,
      message: error,
    };
  }

  return {
    code: null,
    message: 'Unknown media processing failure',
  };
}
