import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMediaPlaybackSignature,
  verifyMediaPlaybackSignature,
} from './token.js';

const SECRET = 'test-only-media-playback-secret';

const ASSET_ID =
  '0c8176a7-87c6-4f97-bf09-6c1fcf32acce';

const OTHER_ASSET_ID =
  '1c8176a7-87c6-4f97-bf09-6c1fcf32acce';

const NOW = 1_800_000_000;
const EXPIRES_AT = NOW + 3600;

test('creates a deterministic playback signature', () => {
  const first = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT },
    SECRET,
  );

  const second = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT },
    SECRET,
  );

  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
});

test('accepts a valid playback signature', () => {
  const signature = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT },
    SECRET,
  );

  const result = verifyMediaPlaybackSignature({
    assetId: ASSET_ID,
    expiresAt: EXPIRES_AT,
    signature,
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: true,
    assetId: ASSET_ID,
    expiresAt: EXPIRES_AT,
  });
});

test('rejects an expired playback signature', () => {
  const signature = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT },
    SECRET,
  );

  const result = verifyMediaPlaybackSignature({
    assetId: ASSET_ID,
    expiresAt: EXPIRES_AT,
    signature,
    secret: SECRET,
    now: EXPIRES_AT,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'expired',
  });
});

test('rejects asset ID tampering', () => {
  const signature = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT },
    SECRET,
  );

  const result = verifyMediaPlaybackSignature({
    assetId: OTHER_ASSET_ID,
    expiresAt: EXPIRES_AT,
    signature,
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_signature',
  });
});

test('rejects expiry tampering', () => {
  const signature = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT },
    SECRET,
  );

  const result = verifyMediaPlaybackSignature({
    assetId: ASSET_ID,
    expiresAt: EXPIRES_AT + 3600,
    signature,
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_signature',
  });
});

test('rejects signature tampering', () => {
  const signature = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT },
    SECRET,
  );

  const tampered =
    `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

  const result = verifyMediaPlaybackSignature({
    assetId: ASSET_ID,
    expiresAt: EXPIRES_AT,
    signature: tampered,
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_signature',
  });
});

test('rejects malformed asset IDs', () => {
  const result = verifyMediaPlaybackSignature({
    assetId: '../some-other-object',
    expiresAt: EXPIRES_AT,
    signature: 'invalid',
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_asset_id',
  });
});

test('rejects invalid expiry values', () => {
  const result = verifyMediaPlaybackSignature({
    assetId: ASSET_ID,
    expiresAt: 0,
    signature: 'invalid',
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_expiry',
  });
});

test('rejects a signature created with another secret', () => {
  const signature = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT },
    'different-secret',
  );

  const result = verifyMediaPlaybackSignature({
    assetId: ASSET_ID,
    expiresAt: EXPIRES_AT,
    signature,
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_signature',
  });
});
