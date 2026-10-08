import { createReadStream } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { FileStorage } from '../../files/storage.js';
import {
  mediaHlsMasterObjectKey,
  mediaHlsRenditionPrefix,
} from '../object-keys.js';
import type { MediaPlatformStore } from '../store.js';
import type {
  MediaAsset,
  MediaVariant,
} from '../types.js';
import { runFfmpeg } from './ffmpeg.js';
import type { StagedMediaSource } from './source.js';

type RenditionName =
  | '1080p'
  | '720p'
  | '480p';

type RenditionDefinition = {
  name: RenditionName;
  targetHeight: number;
  videoBitrate: number;
  maxRate: number;
  bufferSize: number;
  audioBitrate: number;
};

type PreparedRendition = RenditionDefinition & {
  width: number;
  height: number;
  directory: string;
};

export type ProcessAdaptiveHlsInput = {
  asset: MediaAsset;
  source: StagedMediaSource;
  storage: FileStorage;
  store: MediaPlatformStore;
  signal: AbortSignal;
};

export type AdaptiveHlsResult = {
  masterObjectKey: string;
  variants: MediaVariant[];
  renditionCount: number;
};

const RENDITIONS: RenditionDefinition[] = [
  {
    name: '1080p',
    targetHeight: 1080,
    videoBitrate: 4_500_000,
    maxRate: 4_800_000,
    bufferSize: 9_000_000,
    audioBitrate: 128_000,
  },
  {
    name: '720p',
    targetHeight: 720,
    videoBitrate: 2_500_000,
    maxRate: 2_800_000,
    bufferSize: 5_000_000,
    audioBitrate: 128_000,
  },
  {
    name: '480p',
    targetHeight: 480,
    videoBitrate: 1_200_000,
    maxRate: 1_400_000,
    bufferSize: 2_400_000,
    audioBitrate: 96_000,
  },
];

export async function processAdaptiveHls(
  input: ProcessAdaptiveHlsInput,
): Promise<AdaptiveHlsResult> {
  const {
    asset,
    source,
    storage,
    store,
    signal,
  } = input;

  if (!storage.putObjectStream) {
    throw new Error(
      'media_storage_stream_upload_not_supported',
    );
  }

  const sourceWidth = source.probe.width;
  const sourceHeight = source.probe.height;

  if (
    sourceWidth === null ||
    sourceHeight === null
  ) {
    throw new Error(
      'media_hls_source_dimensions_unknown',
    );
  }

  const renditions = selectRenditions(
    sourceWidth,
    sourceHeight,
    source.directory,
  );

  if (renditions.length === 0) {
    throw new Error(
      'media_hls_no_supported_renditions',
    );
  }

  const variants: MediaVariant[] = [];

  for (const rendition of renditions) {
    if (signal.aborted) {
      throwAbortReason(signal);
    }

    await mkdir(
      rendition.directory,
      { recursive: true },
    );

    const playlistPath = join(
      rendition.directory,
      'index.m3u8',
    );

    const segmentPattern = join(
      rendition.directory,
      'segment_%05d.m4s',
    );

    const initFilename = 'init.mp4';

    const objectPrefix =
      mediaHlsRenditionPrefix(
        asset.id,
        rendition.name,
      );

    const playlistObjectKey =
      `${objectPrefix}/index.m3u8`;

    const variant = await store.upsertVariant({
      assetId: asset.id,
      kind: `hls_${rendition.name}`,
      width: rendition.width,
      height: rendition.height,
      bitrateBps: rendition.videoBitrate,
      codec: 'h264',
      container: 'hls',
      bucket: asset.originBucket,
      objectKey: playlistObjectKey,
      sizeBytes: null,
      status: 'processing',
    });

    try {
      await runFfmpeg(
        buildRenditionArgs({
          inputPath: source.inputPath,
          playlistPath,
          segmentPattern,
          initFilename,
          rendition,
          hasAudio:
            source.probe.audioCodec !== null,
        }),
        signal,
      );

      await validateRendition(
        rendition.directory,
      );

      /*
       * Upload media objects before the rendition playlist.
       * A playlist must never reference objects which have not
       * reached object storage yet.
       */
      const uploadedBytes =
        await uploadRenditionDirectory({
          storage,
          bucket: asset.originBucket,
          objectPrefix,
          directory: rendition.directory,
          signal,
        });

      const readyVariant =
        await store.upsertVariant({
          assetId: asset.id,
          kind: `hls_${rendition.name}`,
          width: rendition.width,
          height: rendition.height,
          bitrateBps: rendition.videoBitrate,
          codec: 'h264',
          container: 'hls',
          bucket: asset.originBucket,
          objectKey: playlistObjectKey,
          sizeBytes: uploadedBytes,
          status: 'ready',
        });

      variants.push(readyVariant);
    } catch (error) {
      await store.updateVariantStatus({
        variantId: variant.id,
        status: 'failed',
      }).catch(() => {});

      throw error;
    }
  }

  /*
   * The master playlist is the publication boundary.
   * It is uploaded only after every rendition and its segments
   * are safely present in object storage.
   */
  const master = buildMasterPlaylist(
    renditions,
    source.probe.audioCodec !== null,
  );

  const masterObjectKey =
    mediaHlsMasterObjectKey(asset.id);

  await storage.putObject({
    bucket: asset.originBucket,
    objectKey: masterObjectKey,
    body: Buffer.from(master, 'utf8'),
    contentType:
      'application/vnd.apple.mpegurl',
  });

  return {
    masterObjectKey,
    variants,
    renditionCount: renditions.length,
  };
}

function selectRenditions(
  sourceWidth: number,
  sourceHeight: number,
  rootDirectory: string,
): PreparedRendition[] {
  /*
   * Treat the longest source dimension as the available
   * resolution. This handles portrait video correctly:
   *
   *   1080 x 1920
   *
   * can still produce a 1080-class rendition while preserving
   * its portrait aspect ratio.
   */
  const sourceLongEdge = Math.max(
    sourceWidth,
    sourceHeight,
  );

  const selected = RENDITIONS.filter(
    (rendition) =>
      sourceLongEdge >= rendition.targetHeight,
  );

  /*
   * Very small sources still need one rendition. We use the
   * lowest profile but never upscale either dimension.
   */
  if (selected.length === 0) {
    const lowest =
      RENDITIONS[RENDITIONS.length - 1];

    const dimensions = fitWithinLongEdge(
      sourceWidth,
      sourceHeight,
      sourceLongEdge,
    );

    return [
      {
        ...lowest,
        width: dimensions.width,
        height: dimensions.height,
        directory: join(
          rootDirectory,
          `hls-${lowest.name}`,
        ),
      },
    ];
  }

  return selected.map((rendition) => {
    const dimensions = fitWithinLongEdge(
      sourceWidth,
      sourceHeight,
      rendition.targetHeight,
    );

    return {
      ...rendition,
      width: dimensions.width,
      height: dimensions.height,
      directory: join(
        rootDirectory,
        `hls-${rendition.name}`,
      ),
    };
  });
}

function fitWithinLongEdge(
  sourceWidth: number,
  sourceHeight: number,
  targetLongEdge: number,
): {
  width: number;
  height: number;
} {
  const longEdge = Math.max(
    sourceWidth,
    sourceHeight,
  );

  const scale = Math.min(
    1,
    targetLongEdge / longEdge,
  );

  return {
    width: evenDimension(
      sourceWidth * scale,
    ),
    height: evenDimension(
      sourceHeight * scale,
    ),
  };
}

function evenDimension(
  value: number,
): number {
  const rounded = Math.max(
    2,
    Math.round(value),
  );

  return rounded % 2 === 0
    ? rounded
    : rounded - 1;
}

function buildRenditionArgs(input: {
  inputPath: string;
  playlistPath: string;
  segmentPattern: string;
  initFilename: string;
  rendition: PreparedRendition;
  hasAudio: boolean;
}): string[] {
  const {
    inputPath,
    playlistPath,
    segmentPattern,
    initFilename,
    rendition,
    hasAudio,
  } = input;

  const args = [
    '-y',
    '-i',
    inputPath,

    '-map',
    '0:v:0',

    '-vf',
    `scale=${rendition.width}:${rendition.height}`,

    '-c:v',
    'libx264',

    '-preset',
    'fast',

    '-profile:v',
    'main',

    '-pix_fmt',
    'yuv420p',

    '-crf',
    '21',

    '-b:v',
    String(rendition.videoBitrate),

    '-maxrate',
    String(rendition.maxRate),

    '-bufsize',
    String(rendition.bufferSize),

    '-sc_threshold',
    '0',

    '-force_key_frames',
    'expr:gte(t,n_forced*2)',
  ];

  if (hasAudio) {
    args.push(
      '-map',
      '0:a:0?',

      '-c:a',
      'aac',

      '-b:a',
      String(rendition.audioBitrate),

      '-ac',
      '2',

      '-ar',
      '48000',
    );
  } else {
    args.push('-an');
  }

  args.push(
    '-f',
    'hls',

    '-hls_time',
    '2',

    '-hls_playlist_type',
    'vod',

    '-hls_segment_type',
    'fmp4',

    '-hls_fmp4_init_filename',
    initFilename,

    '-hls_segment_filename',
    segmentPattern,

    playlistPath,
  );

  return args;
}

async function validateRendition(
  directory: string,
): Promise<void> {
  const files = await readdir(directory);

  if (!files.includes('index.m3u8')) {
    throw new Error(
      'media_hls_playlist_missing',
    );
  }

  if (!files.includes('init.mp4')) {
    throw new Error(
      'media_hls_init_segment_missing',
    );
  }

  const mediaSegments = files.filter(
    (filename) =>
      filename.endsWith('.m4s'),
  );

  if (mediaSegments.length === 0) {
    throw new Error(
      'media_hls_segments_missing',
    );
  }

  const playlist = await readFile(
    join(directory, 'index.m3u8'),
    'utf8',
  );

  if (
    !playlist.includes('#EXTM3U') ||
    !playlist.includes('#EXT-X-MAP') ||
    !playlist.includes('.m4s')
  ) {
    throw new Error(
      'media_hls_playlist_invalid',
    );
  }
}

async function uploadRenditionDirectory(
  input: {
    storage: FileStorage;
    bucket: string;
    objectPrefix: string;
    directory: string;
    signal: AbortSignal;
  },
): Promise<number> {
  const {
    storage,
    bucket,
    objectPrefix,
    directory,
    signal,
  } = input;

  if (!storage.putObjectStream) {
    throw new Error(
      'media_storage_stream_upload_not_supported',
    );
  }

  const filenames = await readdir(directory);

  const mediaFiles = filenames
    .filter(
      (filename) =>
        filename === 'init.mp4' ||
        filename.endsWith('.m4s'),
    )
    .sort();

  const playlistFiles = filenames
    .filter(
      (filename) =>
        filename.endsWith('.m3u8'),
    )
    .sort();

  let totalBytes = 0;

  /*
   * Segments and initialization objects first.
   */
  for (const filename of mediaFiles) {
    if (signal.aborted) {
      throwAbortReason(signal);
    }

    totalBytes += await uploadFile({
      storage,
      bucket,
      objectKey:
        `${objectPrefix}/${filename}`,
      path: join(directory, filename),
      contentType: contentTypeFor(
        filename,
      ),
    });
  }

  /*
   * Rendition playlist last.
   */
  for (const filename of playlistFiles) {
    if (signal.aborted) {
      throwAbortReason(signal);
    }

    totalBytes += await uploadFile({
      storage,
      bucket,
      objectKey:
        `${objectPrefix}/${filename}`,
      path: join(directory, filename),
      contentType: contentTypeFor(
        filename,
      ),
    });
  }

  return totalBytes;
}

async function uploadFile(
  input: {
    storage: FileStorage;
    bucket: string;
    objectKey: string;
    path: string;
    contentType: string;
  },
): Promise<number> {
  const {
    storage,
    bucket,
    objectKey,
    path,
    contentType,
  } = input;

  if (!storage.putObjectStream) {
    throw new Error(
      'media_storage_stream_upload_not_supported',
    );
  }

  const fileStat = await stat(path);

  if (
    !fileStat.isFile() ||
    fileStat.size <= 0
  ) {
    throw new Error(
      `media_hls_output_invalid:${objectKey}`,
    );
  }

  const stream = createReadStream(path);

  const webStream = Readable.toWeb(
    stream,
  ) as ReadableStream<Uint8Array>;

  await storage.putObjectStream({
    bucket,
    objectKey,
    body: webStream,
    contentType,
    contentLength: fileStat.size,
  });

  return fileStat.size;
}

function contentTypeFor(
  filename: string,
): string {
  if (filename.endsWith('.m3u8')) {
    return 'application/vnd.apple.mpegurl';
  }

  if (
    filename.endsWith('.m4s') ||
    filename === 'init.mp4'
  ) {
    return 'video/mp4';
  }

  return 'application/octet-stream';
}

function buildMasterPlaylist(
  renditions: PreparedRendition[],
  hasAudio: boolean,
): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
  ];

  for (const rendition of renditions) {
    const bandwidth =
      rendition.videoBitrate +
      (hasAudio ? rendition.audioBitrate : 0);

    const codecs = hasAudio
      ? 'avc1.4d401f,mp4a.40.2'
      : 'avc1.4d401f';

    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rendition.width}x${rendition.height},CODECS="${codecs}"`,
      `${rendition.name}/index.m3u8`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function throwAbortReason(
  signal: AbortSignal,
): never {
  const reason = signal.reason;

  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(
    'media_job_aborted',
  );
}
