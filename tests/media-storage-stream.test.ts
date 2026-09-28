import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MinioFileStorage } from '../src/files/minio-storage.js';

for (const status of [404, 416, 503]) {
  test(`storage releases discarded HTTP ${status} response bodies`, async (t) => {
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => new Response(
      new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
      }), { status, headers: { 'content-range': 'bytes */10' } },
    ));
    const files = new MinioFileStorage({ endpoint: 'http://storage.invalid', accessKey: 'test', secretKey: 'test' });
    if (status === 503) {
      await assert.rejects(files.getObjectStream('media', 'clip.mp4', 'bytes=20-'));
    } else {
      const result = await files.getObjectStream('media', 'clip.mp4', 'bytes=20-');
      assert.equal(result?.status ?? null, status === 404 ? null : 416);
      if (result) assert.equal(result.contentRange, 'bytes */10');
    }
    assert.equal(cancelled, true, 'discarding an unread body must release the storage connection');
  });
}

test('storage forwards ranges without buffering and propagates seek cancellation', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('range'), 'bytes=4-7');
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('4567')); },
      cancel() { cancelled = true; },
    }), { status: 206, headers: { 'content-range': 'bytes 4-7/10', 'content-length': '4', 'content-type': 'video/mp4' } });
  });
  const files = new MinioFileStorage({ endpoint: 'http://storage.invalid', accessKey: 'test', secretKey: 'test' });
  const result = await files.getObjectStream('media', 'clip.mp4', 'bytes=4-7');
  assert.equal(result?.status, 206);
  assert.equal(result?.sizeBytes, 10);
  assert.equal(result?.contentLength, 4);
  const reader = result!.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), '4567');
  await reader.cancel();
  assert.equal(cancelled, true);
});

test('media diagnostics preserve backpressure, cancellation, and safe error reporting', async () => {
  const { observeMediaBody } = await import('../src/content/media-diagnostics.js');
  const records: unknown[] = [];
  const logger = { info: (fields: unknown) => records.push(fields) } as unknown as import('pino').Logger;
  let reads = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const observed = observeMediaBody(source, logger);
  await Promise.resolve();
  assert.equal(reads, 0);
  const reader = observed.getReader();
  await reader.read();
  assert.equal(reads, 1);
  await reader.cancel('secret reason');
  assert.equal(cancelled, true);
  assert.equal(records.length, 1);
  assert.match(JSON.stringify(records), /aborted/);
  assert.doesNotMatch(JSON.stringify(records), /secret/);

  const broken = observeMediaBody(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(Error('secret storage URL')); },
  }), logger);
  await assert.rejects(broken.getReader().read());
  assert.match(JSON.stringify(records), /error/);
  assert.doesNotMatch(JSON.stringify(records), /secret/);

  const complete = observeMediaBody(new ReadableStream<Uint8Array>({
    start(controller) { controller.close(); },
  }), logger);
  assert.equal((await complete.getReader().read()).done, true);
  assert.match(JSON.stringify(records), /complete/);
});
