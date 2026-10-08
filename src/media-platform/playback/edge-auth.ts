import {
  verifyMediaPlaybackSignature,
  type MediaPlaybackTokenVerification,
} from './token.js';

export interface VerifyMediaEdgeRequestInput {
  uri: string;
  secret: string;
  now?: number;
}

export type MediaEdgeRequestVerification =
  | {
      valid: true;
      assetId: string;
      expiresAt: number;
      objectPath: string;
    }
  | {
      valid: false;
      reason:
        | 'invalid_path'
        | 'invalid_asset_id'
        | 'invalid_expiry'
        | 'expired'
        | 'invalid_signature';
    };

const MEDIA_PATH =
  /^\/media\/v1\/([0-9]+)\/([A-Za-z0-9_-]{43})\/([0-9a-fA-F-]{36})\/(hls\/.+)$/;

const HLS_OBJECT_PATH =
  /^hls\/(?:master\.m3u8|(?:1080p|720p|480p)\/(?:index\.m3u8|init\.mp4|segment_[0-9]{5}\.m4s))$/;

function invalid(
  reason: Exclude<
    MediaEdgeRequestVerification,
    { valid: true }
  >['reason'],
): MediaEdgeRequestVerification {
  return {
    valid: false,
    reason,
  };
}

export function verifyMediaEdgeRequest(
  input: VerifyMediaEdgeRequestInput,
): MediaEdgeRequestVerification {
  const match = MEDIA_PATH.exec(input.uri);

  if (!match) {
    return invalid('invalid_path');
  }

  const [, expiryText, signature, assetId, objectPath] =
    match;

  const expiresAt = Number(expiryText);

  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    return invalid('invalid_expiry');
  }

  const verification: MediaPlaybackTokenVerification =
    verifyMediaPlaybackSignature({
      assetId,
      expiresAt,
      signature,
      secret: input.secret,
      now: input.now,
    });

  if (!verification.valid) {
    return invalid(verification.reason);
  }

  if (!HLS_OBJECT_PATH.test(objectPath)) {
    return invalid('invalid_path');
  }

  return {
    valid: true,
    assetId: verification.assetId,
    expiresAt: verification.expiresAt,
    objectPath,
  };
}
