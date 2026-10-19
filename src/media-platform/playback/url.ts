import { createMediaPlaybackSignature } from './token.js';

const DEFAULT_PLAYBACK_TTL_SECONDS = 60 * 60;

export interface CreateMediaPlaybackUrlInput {
  assetId: string;
  generation?: string;
  secret: string;
  basePath?: string;
  ttlSeconds?: number;
  now?: number;
}

export interface MediaPlaybackUrl {
  assetId: string;
  expiresAt: number;
  signature: string;
  path: string;
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();

  if (!trimmed.startsWith('/')) {
    throw new Error('Media playback base path must start with "/"');
  }

  return trimmed.replace(/\/+$/, '');
}

export function createMediaPlaybackUrl(
  input: CreateMediaPlaybackUrlInput,
): MediaPlaybackUrl {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const ttlSeconds =
    input.ttlSeconds ?? DEFAULT_PLAYBACK_TTL_SECONDS;

  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error('Invalid media playback current time');
  }

  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0
  ) {
    throw new Error('Invalid media playback TTL');
  }

  const expiresAt = now + ttlSeconds;

  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('Invalid media playback expiry');
  }

  const signature = createMediaPlaybackSignature(
    {
      assetId: input.assetId,
      expiresAt,
      generation: input.generation,
    },
    input.secret,
  );

  const assetId = input.assetId.toLowerCase();
  const basePath = normalizeBasePath(
    input.basePath ?? (input.generation ? '/media/v2' : '/media/v1'),
  );

  return {
    assetId,
    expiresAt,
    signature,
    path:
      `${basePath}/${expiresAt}/${signature}/` +
      `${assetId}/${input.generation ? `${input.generation}/` : ''}hls/master.m3u8`,
  };
}
