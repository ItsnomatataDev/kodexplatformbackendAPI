import { createMediaPlaybackSignature } from './token.js';

export const MEDIA_INGEST_GRANT_TTL_SECONDS = 12 * 60 * 60;

export function createMediaIngestUrl(input: {
  sessionId: string;
  secret: string;
  publicBaseUrl: string;
  ttlSeconds?: number;
  now?: number;
}) {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = input.ttlSeconds ?? MEDIA_INGEST_GRANT_TTL_SECONDS;
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error('Invalid media ingest current time');
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Invalid media ingest TTL');
  }
  const expiresAt = now + ttlSeconds;
  const sessionId = input.sessionId.toLowerCase();
  const signature = createMediaPlaybackSignature(
    { assetId: sessionId, expiresAt },
    input.secret,
  );
  const base = input.publicBaseUrl.replace(/\/+$/, '');
  const path = `/ingest/v1/${expiresAt}/${signature}/${sessionId}/parts/`;
  return {
    sessionId,
    expiresAt,
    signature,
    path,
    putUrlPrefix: `${base}${path}`,
  };
}
