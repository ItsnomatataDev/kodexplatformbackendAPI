
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { MinioFileStorage } from '../src/files/minio-storage.js';
import { BRANDING_STORAGE_BUCKETS } from '../src/organizations/buckets.js';

async function main() {
  if (!env.minio.accessKey || !env.minio.secretKey) {
    throw new Error('MINIO_ACCESS_KEY / MINIO_SECRET_KEY are required.');
  }

  const files = new MinioFileStorage();
  const buckets = [
    ...BRANDING_STORAGE_BUCKETS,
    ...(env.minio.bucket ? [env.minio.bucket] : []),
  ];
  const unique = [...new Set(buckets)];

  for (const bucket of unique) {
    await files.ensureBucket?.(bucket);
    logger.info({ bucket }, 'Branding storage bucket ready');
  }

  logger.info(
    {
      buckets: unique,
      note: 'organization-branding holds logo / favicon / login_background; profile-pictures holds avatars',
    },
    'Branding MinIO buckets ready',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
