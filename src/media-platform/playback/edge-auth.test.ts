import assert from 'node:assert/strict';
import test from 'node:test';

import { createMediaPlaybackSignature } from './token.js';
import { verifyMediaEdgeRequest } from './edge-auth.js';

const SECRET = 'test-only-media-playback-secret';

const ASSET_ID =
  '0c8176a7-87c6-4f97-bf09-6c1fcf32acce';

const OTHER_ASSET_ID =
  '1c8176a7-87c6-4f97-bf09-6c1fcf32acce';

const NOW = 1_800_000_000;
const EXPIRES_AT = NOW + 3600;

function signatureFor(
  assetId = ASSET_ID,
  expiresAt = EXPIRES_AT,
): string {
  return createMediaPlaybackSignature(
    {
      assetId,
      expiresAt,
    },
    SECRET,
  );
}

function uriFor(
  objectPath: string,
  assetId = ASSET_ID,
  expiresAt = EXPIRES_AT,
  signature = signatureFor(assetId, expiresAt),
): string {
  return (
    `/media/v1/${expiresAt}/${signature}/` +
    `${assetId}/${objectPath}`
  );
}

test('accepts a valid HLS master playlist', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/master.m3u8'),
    secret: SECRET,
    now: NOW,
  });

  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.assetId, ASSET_ID);
    assert.equal(result.expiresAt, EXPIRES_AT);
    assert.equal(result.objectPath, 'hls/master.m3u8');
    assert.match(result.signature, /^[A-Za-z0-9_-]{43}$/);
  }
});

test('accepts a valid HLS rendition playlist', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/1080p/index.m3u8'),
    secret: SECRET,
    now: NOW,
  });

  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.objectPath, 'hls/1080p/index.m3u8');
  }
});

test('accepts a valid HLS init segment', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/1080p/init.mp4'),
    secret: SECRET,
    now: NOW,
  });

  assert.equal(result.valid, true);
});

test('accepts a valid HLS media segment', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/1080p/segment_00001.m4s'),
    secret: SECRET,
    now: NOW,
  });

  assert.equal(result.valid, true);
});

test('rejects an expired signed path', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/master.m3u8'),
    secret: SECRET,
    now: EXPIRES_AT,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'expired',
  });
});

test('rejects a signature for another asset', () => {
  const wrongSignature = signatureFor(OTHER_ASSET_ID);

  const result = verifyMediaEdgeRequest({
    uri: uriFor(
      'hls/master.m3u8',
      ASSET_ID,
      EXPIRES_AT,
      wrongSignature,
    ),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_signature',
  });
});

test('rejects a tampered expiry', () => {
  const signature = signatureFor(
    ASSET_ID,
    EXPIRES_AT,
  );

  const result = verifyMediaEdgeRequest({
    uri: uriFor(
      'hls/master.m3u8',
      ASSET_ID,
      EXPIRES_AT + 3600,
      signature,
    ),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_signature',
  });
});

test('rejects access outside HLS', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('original/video.mp4'),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects dot-dot traversal', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/../original/video.mp4'),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects nested traversal', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor(
      'hls/1080p/../../original/video.mp4',
    ),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects backslash traversal forms', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor(
      'hls/1080p\\..\\original\\video.mp4',
    ),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects repeated path separators', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls//1080p/index.m3u8'),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects malformed asset IDs', () => {
  const signature = signatureFor();

  const result = verifyMediaEdgeRequest({
    uri:
      `/media/v1/${EXPIRES_AT}/${signature}/` +
      `not-an-asset-id/hls/master.m3u8`,
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects malformed signatures', () => {
  const result = verifyMediaEdgeRequest({
    uri:
      `/media/v1/${EXPIRES_AT}/bad-signature/` +
      `${ASSET_ID}/hls/master.m3u8`,
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects unrelated routes', () => {
  const result = verifyMediaEdgeRequest({
    uri: '/api/users',
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects arbitrary files inside HLS', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/private.txt'),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects unsupported HLS renditions', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/4k/index.m3u8'),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects arbitrary files inside a rendition', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/1080p/private.json'),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('rejects malformed HLS segment names', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('hls/720p/segment_1.m4s'),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});

test('accepts a signed original image on the v2 generation path', () => {
  const generation = '17';
  const signature = createMediaPlaybackSignature(
    { assetId: ASSET_ID, expiresAt: EXPIRES_AT, generation },
    SECRET,
  );
  const result = verifyMediaEdgeRequest({
    uri: `/media/v2/${EXPIRES_AT}/${signature}/${ASSET_ID}/${generation}/image/original.jpg`,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.objectPath, 'image/original.jpg');
    assert.equal(result.generation, generation);
  }
});

test('rejects playback MP4 through the HLS edge route', () => {
  const result = verifyMediaEdgeRequest({
    uri: uriFor('playback/playback.mp4'),
    secret: SECRET,
    now: NOW,
  });

  assert.deepEqual(result, {
    valid: false,
    reason: 'invalid_path',
  });
});
