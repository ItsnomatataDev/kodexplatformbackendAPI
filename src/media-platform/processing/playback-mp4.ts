import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { playbackEncodingArgs } from '../../content/playback.js';
import type { FileStorage } from '../../files/storage.js';
import type { MediaPlatformStore } from '../store.js';
import type { MediaAsset, MediaVariant } from '../types.js';
import { mediaPlaybackObjectKey } from '../object-keys.js';
import { probeVideo } from './ffmpeg.js';
import { runFfmpeg } from './ffmpeg.js';
import type { StagedMediaSource } from './source.js';

export type ProcessPlaybackMp4Input = {
  asset: MediaAsset;
  source: StagedMediaSource;
  storage: FileStorage;
  store: MediaPlatformStore;
  signal: AbortSignal;
};

export async function processPlaybackMp4(
  input: ProcessPlaybackMp4Input,
): Promise<MediaVariant> {
  const {
    asset,
    source,
    storage,
    store,
    signal,
  } = input;

  if (!storage.putObjectStream) {
    throw new Error('media_storage_stream_upload_not_supported');
  }

  const outputPath = join(
    source.directory,
    'playback.mp4',
  );

  const objectKey = mediaPlaybackObjectKey(asset.id);

  const variant = await store.upsertVariant({
    assetId: asset.id,
    kind: 'playback_mp4',
    width: null,
    height: null,
    bitrateBps: 3_000_000,
    codec: 'h264',
    container: 'mp4',
    bucket: asset.originBucket,
    objectKey,
    sizeBytes: null,
    status: 'processing',
  });

  try {
    await runFfmpeg(
      playbackEncodingArgs(
        source.inputPath,
        outputPath,
      ),
      signal,
    );

    const outputStat = await stat(outputPath);

    if (
      !outputStat.isFile() ||
      outputStat.size <= 0
    ) {
      throw new Error('media_playback_output_invalid');
    }

    const outputProbe = await probeVideo(
      outputPath,
      signal,
    );

    if (
      outputProbe.width === null ||
      outputProbe.height === null ||
      outputProbe.videoCodec === null
    ) {
      throw new Error('media_playback_output_not_video');
    }

    const fileStream = createReadStream(outputPath);

    const webStream = Readable.toWeb(
      fileStream,
    ) as ReadableStream<Uint8Array>;

    await storage.putObjectStream({
      bucket: asset.originBucket,
      objectKey,
      body: webStream,
      contentType: 'video/mp4',
      contentLength: outputStat.size,
    });

    return await store.upsertVariant({
      assetId: asset.id,
      kind: 'playback_mp4',
      width: outputProbe.width,
      height: outputProbe.height,
      bitrateBps: 3_000_000,
      codec: outputProbe.videoCodec,
      container: 'mp4',
      bucket: asset.originBucket,
      objectKey,
      sizeBytes: outputStat.size,
      status: 'ready',
    });
  } catch (error) {
    await store.updateVariantStatus({
      variantId: variant.id,
      status: 'failed',
    }).catch(() => {});

    throw error;
  }
}
