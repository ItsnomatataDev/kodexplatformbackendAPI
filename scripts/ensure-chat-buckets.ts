/**
 * Ensures MinIO buckets exist for chat images + any-file attachments.
 *
 *   npm run storage:ensure-chat-buckets
 */
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { CHAT_STORAGE_BUCKETS } from '../src/chat/buckets.js';
import { MinioFileStorage } from '../src/files/minio-storage.js';

async function main() {
  if (!env.minio.accessKey || !env.minio.secretKey) {
    throw new Error('MINIO_ACCESS_KEY / MINIO_SECRET_KEY are required.');
  }

  const files = new MinioFileStorage();
  for (const bucket of CHAT_STORAGE_BUCKETS) {
    await files.ensureBucket?.(bucket);
    logger.info({ bucket }, 'Chat storage bucket ready');
  }

  logger.info(
    {
      buckets: [...CHAT_STORAGE_BUCKETS],
      note: 'chat-attachments accepts any file type; chat-images is used for image/* uploads',
    },
    'Chat MinIO buckets ready',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
