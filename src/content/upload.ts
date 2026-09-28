import { logger } from '../config/logger.js';
import type { FileStorage } from '../files/storage.js';
import type { ContentStore } from './store.js';
import { CONTENT_REVIEW_ASSETS_BUCKET } from './buckets.js';

/** Only for freshly generated upload keys, never for an existing library object. */
export async function persistMediaUpload<T>(
  input: {
    organizationId: string;
    objectKey: string;
    files: FileStorage;
    store: Pick<ContentStore, 'findMediaOwnership'>;
  },
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    try {
      // A lost COMMIT acknowledgement must not cause deletion of committed media.
      const referenced = await input.store.findMediaOwnership(input.organizationId, input.objectKey);
      if (!referenced) {
        await input.files.deleteObject(CONTENT_REVIEW_ASSETS_BUCKET, input.objectKey);
      }
    } catch (cleanupError) {
      logger.error({ err: cleanupError, organizationId: input.organizationId, objectKey: input.objectKey },
        'Content upload cleanup requires reconciliation');
    }
    throw error;
  }
}
