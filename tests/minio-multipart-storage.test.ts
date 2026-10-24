import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { MinioMultipartFileStorage } from '../src/files/minio-multipart-storage.js';

test('MinIO adapter streams a part and performs multipart list, complete, and abort operations', async (t) => {
  let receivedPartBytes = 0;
  let completedXml = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const uploadId = url.searchParams.get('uploadId');
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end(
        '<InitiateMultipartUploadResult><UploadId>fake-upload-id</UploadId></InitiateMultipartUploadResult>',
      );
      return;
    }
    if (request.method === 'PUT' && uploadId && url.searchParams.has('partNumber')) {
      for await (const chunk of request) receivedPartBytes += chunk.length;
      response.writeHead(200, { ETag: '"fake-etag"' });
      response.end();
      return;
    }
    if (request.method === 'GET' && uploadId) {
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end(
        `<ListPartsResult><Bucket>content-review-assets</Bucket><Key>org/schedule/file.mp4</Key><UploadId>${uploadId}</UploadId><Part><PartNumber>1</PartNumber><ETag>"fake-etag"</ETag><Size>${receivedPartBytes}</Size></Part><IsTruncated>false</IsTruncated></ListPartsResult>`,
      );
      return;
    }
    if (request.method === 'POST' && uploadId) {
      for await (const chunk of request) completedXml += chunk.toString();
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end(
        '<CompleteMultipartUploadResult><Location>http://localhost/bucket/key</Location><Bucket>content-review-assets</Bucket><Key>org/schedule/file.mp4</Key><ETag>"complete-etag"</ETag></CompleteMultipartUploadResult>',
      );
      return;
    }
    if (request.method === 'DELETE' && uploadId) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const storage = new MinioMultipartFileStorage({
    endpoint: `http://127.0.0.1:${address.port}`,
    accessKey: 'test-access-key',
    secretKey: 'test-secret-key',
    region: 'us-east-1',
  });
  const bucket = 'content-review-assets';
  const objectKey = 'org/schedule/file.mp4';
  const uploadId = await storage.initiateMultipartUpload(bucket, objectKey, 'video/mp4');
  assert.equal(uploadId, 'fake-upload-id');

  const partBytes = 5 * 1024 * 1024;
  const part = await storage.putMultipartPartStream({
    bucket,
    objectKey,
    uploadId,
    partNumber: 1,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < partBytes; offset += 1024 * 1024) {
          controller.enqueue(new Uint8Array(Math.min(1024 * 1024, partBytes - offset)));
        }
        controller.close();
      },
    }),
    contentLength: partBytes,
  });
  assert.equal(part.etag, 'fake-etag');
  assert.equal(receivedPartBytes, partBytes);

  const parts = await storage.listMultipartParts(bucket, objectKey, uploadId);
  assert.deepEqual(parts, [{ partNumber: 1, sizeBytes: partBytes, etag: 'fake-etag' }]);
  await storage.completeMultipartUpload(bucket, objectKey, uploadId, parts);
  assert.match(completedXml, /<PartNumber>1<\/PartNumber>/);
  await storage.abortMultipartUpload(bucket, objectKey, uploadId);
});
