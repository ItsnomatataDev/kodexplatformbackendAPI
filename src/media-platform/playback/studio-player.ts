export type StudioMediaKind = 'video' | 'image';

export type StudioMediaSourceInput = {
  kind: StudioMediaKind;
  playbackReady: boolean;
  playbackUrl: string | null;
  proxyUrl: string;
};

/**
 * Codex uses a Redis-backed edge grant for ready HLS video and signed originals.
 * Unready media and non-staff surfaces stay on the studio proxy.
 */
export function resolveStudioMediaSource(input: StudioMediaSourceInput): string {
  if (
    !input.playbackReady ||
    typeof input.playbackUrl !== 'string' ||
    !input.playbackUrl.startsWith('https://')
  ) {
    return input.proxyUrl;
  }
  if (input.kind === 'video') {
    return input.playbackUrl;
  }
  if (input.kind === 'image' && /\/image\/original(?:\.(?:jpe?g|png|webp|gif))?(?:$|\?)/.test(input.playbackUrl)) {
    return input.playbackUrl;
  }
  return input.proxyUrl;
}

export function shouldRenewPlaybackGrant(
  expiresAt: number,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  return expiresAt - nowSeconds <= 60;
}
