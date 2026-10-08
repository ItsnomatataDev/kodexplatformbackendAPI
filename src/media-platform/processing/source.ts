import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FileStorage } from '../../files/storage.js';
import { probeVideo, type VideoProbe } from './ffmpeg.js';

export const MAX_MEDIA_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

export type StagedMediaSource = {
  directory: string;
  inputPath: string;
  sizeBytes: number;
  probe: VideoProbe;
  cleanup(): Promise<void>;
};

export async function stageMediaSource(
  storage: FileStorage,
  bucket: string,
  objectKey: string,
  signal: AbortSignal,
): Promise<StagedMediaSource> {
  if (!storage.headObject) {
    throw new Error('media_storage_head_not_supported');
  }

  if (!storage.getObjectStream) {
    throw new Error('media_storage_stream_not_supported');
  }

  const head = await storage.headObject(bucket, objectKey);

  if (!head) {
    throw new Error('media_source_not_found');
  }

  if (
    head.sizeBytes !== null &&
    head.sizeBytes > MAX_MEDIA_SOURCE_BYTES
  ) {
    throw new Error('media_source_too_large');
  }

  const object = await storage.getObjectStream(
    bucket,
    objectKey,
    null,
  );

  if (!object || object.status !== 200) {
    throw new Error('media_source_stream_unavailable');
  }

  if (
    object.sizeBytes !== null &&
    object.sizeBytes > MAX_MEDIA_SOURCE_BYTES
  ) {
    throw new Error('media_source_too_large');
  }

  if (
    object.contentLength !== null &&
    object.contentLength > MAX_MEDIA_SOURCE_BYTES
  ) {
    throw new Error('media_source_too_large');
  }

  const directory = await mkdtemp(
    join(tmpdir(), 'kode-media-'),
  );

  const inputPath = join(directory, 'source');

  let downloadedBytes = 0;

  const byteLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.length;

      if (downloadedBytes > MAX_MEDIA_SOURCE_BYTES) {
        callback(new Error('media_source_too_large'));
        return;
      }

      callback(null, chunk);
    },
  });

  try {
    const nodeStream = Readable.from(
      object.body as AsyncIterable<Uint8Array>,
    );

    await pipeline(
      nodeStream,
      byteLimiter,
      createWriteStream(inputPath, {
        flags: 'wx',
        mode: 0o600,
      }),
      { signal },
    );

    if (
      head.sizeBytes !== null &&
      downloadedBytes !== head.sizeBytes
    ) {
      throw new Error('media_source_size_mismatch');
    }

    const probe = await probeVideo(inputPath, signal);

    if (
      probe.width === null ||
      probe.height === null ||
      probe.videoCodec === null
    ) {
      throw new Error('media_source_has_no_video');
    }

    return {
      directory,
      inputPath,
      sizeBytes: downloadedBytes,
      probe,
      cleanup: async () => {
        await rm(directory, {
          recursive: true,
          force: true,
        });
      },
    };
  } catch (error) {
    await rm(directory, {
      recursive: true,
      force: true,
    });

    throw error;
  }
}
