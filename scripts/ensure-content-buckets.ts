/**
 * Ensures MinIO bucket exists for Content Studio media.
 *
 *   npm run storage:ensure-content-buckets
 */
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { CONTENT_STORAGE_BUCKETS } from '../src/content/buckets.js';
import { MinioFileStorage } from '../src/files/minio-storage.js';

async function main() {
  if (!env.minio.accessKey || !env.minio.secretKey) {
    throw new Error('MINIO_ACCESS_KEY / MINIO_SECRET_KEY are required.');
  }

  const files = new MinioFileStorage();
  for (const bucket of CONTENT_STORAGE_BUCKETS) {
    await files.ensureBucket?.(bucket);
    logger.info({ bucket }, 'Content Studio storage bucket ready');
  }

  logger.info(
    { buckets: [...CONTENT_STORAGE_BUCKETS] },
    'Content Studio MinIO buckets ready',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
