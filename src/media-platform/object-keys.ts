function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function mediaAssetPrefix(assetId: string): string {
  return `.media/v1/${safeSegment(assetId)}`;
}

export function mediaOriginalObjectKey(
  assetId: string,
  filename: string,
): string {
  return `${mediaAssetPrefix(assetId)}/original/${safeSegment(filename)}`;
}

export function mediaPlaybackObjectKey(assetId: string): string {
  return `${mediaAssetPrefix(assetId)}/playback/playback.mp4`;
}

export function mediaHlsPrefix(assetId: string): string {
  return `${mediaAssetPrefix(assetId)}/hls`;
}

export function mediaHlsMasterObjectKey(assetId: string): string {
  return `${mediaHlsPrefix(assetId)}/master.m3u8`;
}

export function mediaHlsRenditionPrefix(
  assetId: string,
  rendition: '1080p' | '720p' | '480p',
): string {
  return `${mediaHlsPrefix(assetId)}/${rendition}`;
}

export function mediaThumbnailObjectKey(assetId: string): string {
  return `${mediaAssetPrefix(assetId)}/thumbnails/poster.jpg`;
}
