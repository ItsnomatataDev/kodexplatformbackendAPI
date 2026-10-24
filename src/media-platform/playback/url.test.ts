import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyMediaPlaybackSignature } from './token.js';
import { createMediaPlaybackUrl } from './url.js';

const SECRET = 'test-only-media-playback-secret';

const ASSET_ID =
  '0c8176a7-87c6-4f97-bf09-6c1fcf32acce';

const NOW = 1_800_000_000;

test('creates the expected signed HLS playback path', () => {
  const result = createMediaPlaybackUrl({
    assetId: ASSET_ID,
    secret: SECRET,
    now: NOW,
    ttlSeconds: 3600,
  });

  assert.equal(result.assetId, ASSET_ID);
  assert.equal(result.expiresAt, NOW + 3600);

  assert.equal(
    result.path,
    `/media/v1/${result.expiresAt}/${result.signature}/${ASSET_ID}/hls/master.m3u8`,
  );

  assert.match(
    result.signature,
    /^[A-Za-z0-9_-]{43}$/,
  );
});

test('generated URL signature verifies successfully', () => {
  const result = createMediaPlaybackUrl({
    assetId: ASSET_ID,
    secret: SECRET,
    now: NOW,
    ttlSeconds: 3600,
  });

  const verification = verifyMediaPlaybackSignature({
    assetId: result.assetId,
    expiresAt: result.expiresAt,
    signature: result.signature,
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(verification, {
    valid: true,
    assetId: ASSET_ID,
    expiresAt: NOW + 3600,
  });
});

test('uses one hour as the default TTL', () => {
  const result = createMediaPlaybackUrl({
    assetId: ASSET_ID,
    secret: SECRET,
    now: NOW,
  });

  assert.equal(
    result.expiresAt,
    NOW + 3600,
  );
});

test('normalizes a trailing slash in the base path', () => {
  const result = createMediaPlaybackUrl({
    assetId: ASSET_ID,
    secret: SECRET,
    now: NOW,
    basePath: '/private/media/',
  });

  assert.ok(
    result.path.startsWith('/private/media/'),
  );

  assert.equal(
    result.path.includes('/private/media//'),
    false,
  );
});

test('rejects a base path without a leading slash', () => {
  assert.throws(
    () =>
      createMediaPlaybackUrl({
        assetId: ASSET_ID,
        secret: SECRET,
        now: NOW,
        basePath: 'media/v1',
      }),
    /must start with/,
  );
});

test('rejects zero TTL', () => {
  assert.throws(
    () =>
      createMediaPlaybackUrl({
        assetId: ASSET_ID,
        secret: SECRET,
        now: NOW,
        ttlSeconds: 0,
      }),
    /Invalid media playback TTL/,
  );
});

test('rejects negative TTL', () => {
  assert.throws(
    () =>
      createMediaPlaybackUrl({
        assetId: ASSET_ID,
        secret: SECRET,
        now: NOW,
        ttlSeconds: -1,
      }),
    /Invalid media playback TTL/,
  );
});

test('rejects invalid current time', () => {
  assert.throws(
    () =>
      createMediaPlaybackUrl({
        assetId: ASSET_ID,
        secret: SECRET,
        now: 0,
      }),
    /Invalid media playback current time/,
  );
});
