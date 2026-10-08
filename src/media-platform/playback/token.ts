import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

const TOKEN_VERSION = 'v1';

export interface MediaPlaybackTokenPayload {
  assetId: string;
  expiresAt: number;
}

export interface VerifyMediaPlaybackTokenInput {
  assetId: string;
  expiresAt: number;
  signature: string;
  secret: string;
  now?: number;
}

export type MediaPlaybackTokenVerification =
  | {
      valid: true;
      assetId: string;
      expiresAt: number;
    }
  | {
      valid: false;
      reason:
        | 'invalid_asset_id'
        | 'invalid_expiry'
        | 'expired'
        | 'invalid_signature';
    };

function assertAssetId(assetId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) {
    throw new Error('Invalid media asset ID');
  }
}

function assertExpiry(expiresAt: number): void {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error('Invalid media playback expiry');
  }
}

function signingPayload(
  assetId: string,
  expiresAt: number,
): string {
  return `${TOKEN_VERSION}\n${assetId}\n${expiresAt}`;
}

function sign(
  assetId: string,
  expiresAt: number,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(signingPayload(assetId, expiresAt), 'utf8')
    .digest('base64url');
}

export function createMediaPlaybackSignature(
  payload: MediaPlaybackTokenPayload,
  secret: string,
): string {
  assertAssetId(payload.assetId);
  assertExpiry(payload.expiresAt);

  if (!secret) {
    throw new Error('Media playback signing secret is required');
  }

  return sign(
    payload.assetId.toLowerCase(),
    payload.expiresAt,
    secret,
  );
}

export function verifyMediaPlaybackSignature(
  input: VerifyMediaPlaybackTokenInput,
): MediaPlaybackTokenVerification {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.assetId,
    )
  ) {
    return {
      valid: false,
      reason: 'invalid_asset_id',
    };
  }

  if (
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= 0
  ) {
    return {
      valid: false,
      reason: 'invalid_expiry',
    };
  }

  const now = input.now ?? Math.floor(Date.now() / 1000);

  if (input.expiresAt <= now) {
    return {
      valid: false,
      reason: 'expired',
    };
  }

  if (!input.secret || !input.signature) {
    return {
      valid: false,
      reason: 'invalid_signature',
    };
  }

  const expected = sign(
    input.assetId.toLowerCase(),
    input.expiresAt,
    input.secret,
  );

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(input.signature, 'utf8');

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return {
      valid: false,
      reason: 'invalid_signature',
    };
  }

  return {
    valid: true,
    assetId: input.assetId.toLowerCase(),
    expiresAt: input.expiresAt,
  };
}
