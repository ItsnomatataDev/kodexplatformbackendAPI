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
      generation?: string;
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
  const v2 = /^\/media\/v2\/([0-9]+)\/([A-Za-z0-9_-]{43})\/([0-9a-fA-F-]{36})\/([1-9][0-9]{0,18})\/(hls\/.+)$/.exec(input.uri);
  const match = v2 ? [v2[0],v2[1],v2[2],v2[3],v2[5]] : MEDIA_PATH.exec(input.uri);
  const generation = v2?.[4];

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
      generation,
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
    ...(generation ? { generation } : {}),
  };
}
