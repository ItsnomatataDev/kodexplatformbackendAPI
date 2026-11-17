import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaIngestSigner } from './ingest-signer.js';

test('signs a multipart PUT for the exact object and part', async () => {
  const calls: unknown[][] = [];
  const signer = createMediaIngestSigner({
    ttlSeconds: 60,
    client: {
      async presignedUrl(...args) {
        calls.push(args);
        return 'http://minio:9000/content-review-assets/org/file.mp4?uploadId=abc&partNumber=3';
      },
    },
  });
  const url = await signer.sign({
    bucket: 'content-review-assets',
    objectKey: 'org/file.mp4',
    uploadId: 'abc',
    partNumber: 3,
  });
  assert.equal(url, 'http://minio:9000/content-review-assets/org/file.mp4?uploadId=abc&partNumber=3');
  assert.deepEqual(calls, [
    [
      'PUT',
      'content-review-assets',
      'org/file.mp4',
      60,
      { uploadId: 'abc', partNumber: '3' },
    ],
  ]);
});
