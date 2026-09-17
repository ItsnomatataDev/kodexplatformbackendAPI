import { createHash } from 'node:crypto';
import type { FileStorage, PutObjectInput, StoredObject } from './storage.js';

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

  async deleteObject(bucket: string, objectKey: string) {
    this.objects.delete(this.key(bucket, objectKey));
  }

  private key(bucket: string, objectKey: string) {
    return `${bucket}:${objectKey}`;
  }
}
