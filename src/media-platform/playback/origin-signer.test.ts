import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMediaOriginSigner,
  mediaOriginObjectKey,
} from './origin-signer.js';

const ASSET_ID =
  '0c8176a7-87c6-4f97-bf09-6c1fcf32acce';

test('constructs the derived media object key', () => {
  assert.equal(
    mediaOriginObjectKey(
      ASSET_ID,
      'hls/720p/segment_00001.m4s',
    ),
    `.media/v1/${ASSET_ID}/hls/720p/segment_00001.m4s`,
  );
});

test('signs the exact derived media object', async () => {
  const calls: unknown[][] = [];

  const signer = createMediaOriginSigner({
    bucket: 'content-review-assets',
    ttlSeconds: 60,
    client: {
      async presignedGetObject(...args) {
        calls.push(args);
        return 'http://minio:9000/signed-object';
      },
    },
  });

  const url = await signer.sign({
    assetId: ASSET_ID,
    objectPath: 'hls/master.m3u8',
  });

  assert.equal(
    url,
    'http://minio:9000/signed-object',
  );

  assert.deepEqual(calls, [
    [
      'content-review-assets',
      `.media/v1/${ASSET_ID}/hls/master.m3u8`,
      60,
    ],
  ]);
});

test('rejects an empty bucket', () => {
  assert.throws(
    () =>
      createMediaOriginSigner({
        bucket: '',
        client: {
          async presignedGetObject() {
            return '';
          },
        },
      }),
    /bucket/i,
  );
});

test('rejects excessive origin URL TTL', () => {
  assert.throws(
    () =>
      createMediaOriginSigner({
        bucket: 'content-review-assets',
        ttlSeconds: 301,
        client: {
          async presignedGetObject() {
            return '';
          },
        },
      }),
    /TTL/i,
  );
});
