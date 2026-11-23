import { db } from '../db/pool.js';
import type { FileStorage } from '../files/storage.js';
import { logger } from '../config/logger.js';
import {
  mediaAssetPrefix,
  mediaGenerationPrefix,
} from '../media-platform/object-keys.js';

async function deleteQuietly(
  files: FileStorage,
  bucket: string,
  objectKey: string,
) {
  await files.deleteObject(bucket, objectKey).catch((err) => {
    logger.error(
      { err, bucket, objectKey },
      'Content media object delete requires reconciliation',
    );
  });
}

async function deletePrefix(
  files: FileStorage,
  bucket: string,
  prefix: string,
) {
  if (!files.listObjectKeys) return;
  const keys = await files.listObjectKeys(bucket, prefix).catch((err) => {
    logger.error({ err, bucket, prefix }, 'Content media prefix list failed');
    return [] as string[];
  });
  for (const key of keys) {
    await deleteQuietly(files, bucket, key);
  }
}

/**
 * Remove the original object and any HLS/image derivatives for that source.
 * Safe when media_platform has no matching row.
 */
export async function purgeContentStudioObject(params: {
  files: FileStorage;
  bucket: string;
  objectKey: string;
}) {
  const { files, bucket, objectKey } = params;
  await deleteQuietly(files, bucket, objectKey);

  const assets = await db
    .query<{
      id: string;
      origin_bucket: string;
      hls_generation: string | null;
      playback_generation: string | null;
    }>(
      `SELECT id, origin_bucket, hls_generation, playback_generation
       FROM media_platform.assets
       WHERE origin_bucket = $1 AND origin_object_key = $2
         AND status <> 'deleted'`,
      [bucket, objectKey],
    )
    .catch((err) => {
      logger.error({ err, objectKey }, 'Media platform lookup failed during purge');
      return { rows: [] as Array<{
        id: string;
        origin_bucket: string;
        hls_generation: string | null;
        playback_generation: string | null;
      }> };
    });

  for (const asset of assets.rows) {
    const variants = await db
      .query<{ bucket: string; object_key: string }>(
        `SELECT bucket, object_key FROM media_platform.variants WHERE asset_id = $1`,
        [asset.id],
      )
      .catch(() => ({ rows: [] as Array<{ bucket: string; object_key: string }> }));
    for (const variant of variants.rows) {
      await deleteQuietly(files, variant.bucket, variant.object_key);
    }

    await deletePrefix(files, asset.origin_bucket, `${mediaAssetPrefix(asset.id)}/`);
    if (asset.hls_generation) {
      await deletePrefix(
        files,
        asset.origin_bucket,
        `${mediaGenerationPrefix(asset.id, asset.hls_generation)}/`,
      );
    }
    if (asset.playback_generation) {
      await deletePrefix(
        files,
        asset.origin_bucket,
        `${mediaGenerationPrefix(asset.id, asset.playback_generation)}/`,
      );
    }

    await db
      .query(
        `UPDATE media_platform.assets
         SET status = 'deleted', updated_at = NOW()
         WHERE id = $1 AND status <> 'deleted'`,
        [asset.id],
      )
      .catch((err) => {
        logger.error({ err, assetId: asset.id }, 'Media platform mark-deleted failed');
      });
  }
}
