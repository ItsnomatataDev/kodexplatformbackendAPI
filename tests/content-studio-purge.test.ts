import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTENT_REVIEW_ASSETS_BUCKET as bucket } from '../src/content/buckets.js';
import { purgeContentStudioObject } from '../src/content/purge-object.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';

test('memory storage lists keys under a prefix', async () => {
  const files = new MemoryFileStorage();
  await files.putObject({
    bucket,
    objectKey: 'org/keep.png',
    body: Buffer.from('keep'),
  });
  await files.putObject({
    bucket,
    objectKey: '.media/v2/asset/1/hls/master.m3u8',
    body: Buffer.from('m3u8'),
  });
  await files.putObject({
    bucket,
    objectKey: '.media/v2/asset/1/hls/480p/segment_00001.m4s',
    body: Buffer.from('seg'),
  });
  const keys = await files.listObjectKeys!(bucket, '.media/v2/asset/1/');
  assert.deepEqual(keys.sort(), [
    '.media/v2/asset/1/hls/480p/segment_00001.m4s',
    '.media/v2/asset/1/hls/master.m3u8',
  ]);
});

test('purge deletes the original object even when media-platform is empty', async () => {
  const files = new MemoryFileStorage();
  await files.putObject({
    bucket,
    objectKey: 'org/shot.jpg',
    body: Buffer.from('jpeg'),
  });
  await purgeContentStudioObject({
    files,
    bucket,
    objectKey: 'org/shot.jpg',
  });
  assert.equal(await files.getObject(bucket, 'org/shot.jpg'), null);
});
