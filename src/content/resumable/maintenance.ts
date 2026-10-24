import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { PostgresContentStore } from '../postgres-store.js';
import { MinioFileStorage } from '../../files/minio-storage.js';
import { MinioMultipartFileStorage } from '../../files/minio-multipart-storage.js';
import { PostgresUploadSessionRepository } from './postgres-repository.js';
import { ResumableUploadService } from './service.js';

export async function runContentStudioUploadMaintenance() {
  const service = new ResumableUploadService({
    repository: new PostgresUploadSessionRepository(),
    content: new PostgresContentStore(),
    files: new MinioFileStorage(),
    multipart: new MinioMultipartFileStorage(),
    config: {
      enabled: env.contentStudioUploads.resumableEnabled,
      maxFileBytes: env.limits.maxContentStudioUploadBytes,
      partSizeBytes: env.contentStudioUploads.partSizeBytes,
      sessionInactivityMs: env.contentStudioUploads.sessionInactivityMs,
      terminalRetentionMs: env.contentStudioUploads.terminalRetentionMs,
      maxActiveSessionsPerUser: env.contentStudioUploads.maxActiveSessionsPerUser,
      maxActiveSessionsPerOrganization:
        env.contentStudioUploads.maxActiveSessionsPerOrganization,
      maxReservedBytesPerUser: env.contentStudioUploads.maxReservedBytesPerUser,
      maxReservedBytesPerOrganization:
        env.contentStudioUploads.maxReservedBytesPerOrganization,
      maxConcurrentPartsPerSession:
        env.contentStudioUploads.maxConcurrentPartsPerSession,
      maxConcurrentPartsPerUser: env.contentStudioUploads.maxConcurrentPartsPerUser,
      maxConcurrentPartsPerOrganization:
        env.contentStudioUploads.maxConcurrentPartsPerOrganization,
    },
  });

  const initiations = await service.recoverInitiations();
  const completions = await service.recoverCompletions();
  const cleanup = await service.cleanupExpired();
  const purged = await service.purgeTerminalSessions();
  const failures =
    initiations.failures + completions.failures + cleanup.failures;

  logger.info(
    { initiations, completions, cleanup, purged },
    'content_studio_upload_maintenance_finished',
  );

  return { failures };
}
