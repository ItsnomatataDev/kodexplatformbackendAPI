import {
  randomBytes,
  createHmac,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import type { InfrastructureConfig } from '../config.js';
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (
  c: InfrastructureConfig,
  purpose: string,
  value: string,
) =>
  createHmac('sha256', c.tokenKey).update(`${purpose}:${value}`).digest('hex');
export const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export type SecretBox = {
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
};
export function seal(
  c: InfrastructureConfig,
  accountId: string,
  secret: string,
): SecretBox {
  const nonce = randomBytes(12),
    cipher = createCipheriv(
      'aes-256-gcm',
      c.encryptionKeys[c.activeKeyId],
      nonce,
    );
  cipher.setAAD(Buffer.from(`infrastructure:totp:${accountId}`));
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  return {
    keyId: c.activeKeyId,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
export function unseal(
  c: InfrastructureConfig,
  accountId: string,
  box: SecretBox,
) {
  const key = c.encryptionKeys[box.keyId];
  if (!key) throw new Error('MFA key unavailable');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(box.nonce, 'base64'),
  );
  decipher.setAAD(Buffer.from(`infrastructure:totp:${accountId}`));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(box.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// Random 256-bit bootstrap capabilities need no runtime secret to hash.
export const bootstrapDigest = (value: string) =>
  createHash('sha256')
    .update(`infrastructure:bootstrap:${value}`)
    .digest('hex');
