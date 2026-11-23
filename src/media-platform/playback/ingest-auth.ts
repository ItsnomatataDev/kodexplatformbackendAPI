import { verifyMediaPlaybackSignature } from './token.js';

export type MediaIngestRequestVerification =
  | {
      valid: true;
      sessionId: string;
      signature: string;
      expiresAt: number;
      partNumber: number;
    }
  | {
      valid: false;
      reason: 'invalid_path' | 'invalid_session_id' | 'invalid_expiry' | 'expired' | 'invalid_signature';
    };

const INGEST_PATH =
  /^\/ingest\/v1\/([0-9]+)\/([A-Za-z0-9_-]{43})\/([0-9a-fA-F-]{36})\/parts\/([1-9][0-9]{0,4})(?:\?.*)?$/;

export function verifyMediaIngestRequest(input: {
  uri: string;
  secret: string;
  now?: number;
}): MediaIngestRequestVerification {
  const match = INGEST_PATH.exec(input.uri);
  if (!match) {
    return { valid: false, reason: 'invalid_path' };
  }

  const expiresAt = Number(match[1]);
  const signature = match[2]!;
  const sessionId = match[3]!;
  const partNumber = Number(match[4]);

  const verification = verifyMediaPlaybackSignature({
    assetId: sessionId,
    expiresAt,
    signature,
    secret: input.secret,
    now: input.now,
  });

  if (!verification.valid) {
    return {
      valid: false,
      reason:
        verification.reason === 'invalid_asset_id'
          ? 'invalid_session_id'
          : verification.reason,
    };
  }

  return {
    valid: true,
    sessionId: verification.assetId,
    signature,
    expiresAt: verification.expiresAt,
    partNumber,
  };
}
