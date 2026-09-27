import { createHash } from 'node:crypto';
import type {
  FileStorage,
  ObjectStreamResult,
  PutObjectInput,
  PutObjectStreamInput,
  StoredObject,
} from './storage.js';

async function bufferFromStream(
  body: ReadableStream<Uint8Array> | Buffer,
  contentLength: number,
) {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > contentLength) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Stream exceeded declared Content-Length.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export class MemoryFileStorage implements FileStorage {
  private readonly objects = new Map<string, StoredObject>();

  async putObject(input: PutObjectInput) {
    const body = Buffer.from(input.body);
    this.objects.set(this.key(input.bucket, input.objectKey), {
      bucket: input.bucket,
      objectKey: input.objectKey,
      contentType: input.contentType ?? null,
      sizeBytes: body.byteLength,
      checksum: createHash('sha256').update(body).digest('hex'),
      body,
    });
  }

  async putObjectStream(input: PutObjectStreamInput) {
    const body = await bufferFromStream(input.body, input.contentLength);
    await this.putObject({
      bucket: input.bucket,
      objectKey: input.objectKey,
      body,
      contentType: input.contentType,
    });
  }

  async getObject(bucket: string, objectKey: string) {
    const stored = this.objects.get(this.key(bucket, objectKey));
    if (!stored) {
      return null;
    }

    return {
      ...stored,
      body: Buffer.from(stored.body),
    };
  }

  async headObject(bucket: string, objectKey: string) {
    const stored = await this.getObject(bucket, objectKey);
    if (!stored) return null;
    return {
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
    };
  }

  async getObjectStream(
    bucket: string,
    objectKey: string,
    rangeHeader?: string | null,
  ): Promise<ObjectStreamResult | null> {
    const stored = await this.getObject(bucket, objectKey);
    if (!stored) return null;

    const size = stored.sizeBytes;
    let start = 0;
    let end = size - 1;
    let status: 200 | 206 = 200;
    let contentRange: string | null = null;

    if (rangeHeader?.trim()) {
      const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
      if (!match) {
        return {
          bucket, objectKey, contentType: stored.contentType, sizeBytes: size,
          contentLength: 0, contentRange: `bytes */${size}`, status: 416,
          body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        };
      }
      const rawStart = match[1] === '' ? NaN : Number(match[1]);
      const rawEnd = match[2] === '' ? NaN : Number(match[2]);
      if (Number.isNaN(rawStart) && !Number.isNaN(rawEnd)) {
        start = Math.max(0, size - rawEnd);
        end = size - 1;
      } else {
        start = Number.isNaN(rawStart) ? 0 : rawStart;
        end = Number.isNaN(rawEnd) ? size - 1 : Math.min(rawEnd, size - 1);
      }
      if (start < 0 || end < start || start >= size) {
        return {
          bucket, objectKey, contentType: stored.contentType, sizeBytes: size,
          contentLength: 0, contentRange: `bytes */${size}`, status: 416,
          body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        };
      }
      status = 206;
      contentRange = `bytes ${start}-${end}/${size}`;
    }

    const slice = stored.body.subarray(start, end + 1);
    return {
      bucket,
      objectKey,
      contentType: stored.contentType,
      sizeBytes: size,
      contentLength: slice.byteLength,
      contentRange,
      status,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(slice));
          controller.close();
        },
      }),
    };
  }

  async deleteObject(bucket: string, objectKey: string) {
    this.objects.delete(this.key(bucket, objectKey));
  }

  async ensureBucket(_bucket: string) {
    // Memory storage has no buckets to create.
  }

  private key(bucket: string, objectKey: string) {
    return `${bucket}:${objectKey}`;
  }
}
