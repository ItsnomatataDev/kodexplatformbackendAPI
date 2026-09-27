import { createHash, randomBytes } from 'node:crypto';

export function generateContentReviewToken() {
  return randomBytes(24).toString('hex');
}

export function generatePortalToken() {
  return randomBytes(24).toString('hex');
}

export function generateNumericPin(length = 6) {
  const digits = '0123456789';
  const bytes = randomBytes(length);
  let pin = '';
  for (let i = 0; i < length; i += 1) {
    pin += digits[bytes[i]! % 10];
  }
  return pin;
}

export function hashClientPin(portalToken: string, pin: string) {
  return createHash('sha256')
    .update(`${portalToken}:${pin}`)
    .digest('hex');
}

/** Deterministic portal session — matches Supabase content_client_session_hash. */
export function hashClientSession(params: {
  portalToken: string;
  email: string;
  loginPinHash: string;
}) {
  return createHash('sha256')
    .update(
      `${params.portalToken}:${params.email.trim().toLowerCase()}:${params.loginPinHash}`,
    )
    .digest('hex');
}

export function contentReviewLinkExpiresAt(days = 90) {
  const expires = new Date();
  expires.setUTCDate(expires.getUTCDate() + days);
  return expires;
}
