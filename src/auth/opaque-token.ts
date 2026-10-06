import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashOpaqueToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

/** Recover a concurrent refresh's successor without storing raw tokens.
 * replacementId is newly random for each rotation. The domain separates this
 * HMAC from token hashing, and the server secret is required for derivation.
 */
export function deriveRefreshToken(
  secret: string,
  previousToken: string,
  replacementId: string,
): string {
  return createHmac('sha256', secret)
    .update('kode-refresh-successor-v1\0')
    .update(replacementId)
    .update('\0')
    .update(previousToken)
    .digest('base64url');
}

export function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
