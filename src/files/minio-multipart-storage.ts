import { Agent } from 'node:https';
import { Readable } from 'node:stream';
import { Client } from 'minio';
import { env } from '../config/env.js';
import type { MultipartFileStorage, MultipartPart } from './storage.js';

type MinioMultipartPart = {
  part: number;
  size: number;
  etag: string;
};

function sanitizedMultipartError(operation: string) {
  return new Error(`minio_multipart_${operation}_failed`);
}

class StreamingMultipartClient extends Client {
  constructor(options: ConstructorParameters<typeof Client>[0]) {
    super(options);
    this.enableSHA256 = false;
  }

  async putPartStream(input: {
    bucket: string;
    objectKey: string;
    uploadId: string;
    partNumber: number;
    body: ReadableStream<Uint8Array>;
    contentLength: number;
  }) {
    const region = this.region ?? (await this.getBucketRegionAsync(input.bucket));
    const response = await this.makeRequestStreamAsync(
      {
        method: 'PUT',
        bucketName: input.bucket,
        objectName: input.objectKey,
        query: `uploadId=${encodeURIComponent(input.uploadId)}&partNumber=${input.partNumber}`,
        headers: { 'Content-Length': String(input.contentLength) },
      },
      Readable.fromWeb(
        input.body as import('node:stream/web').ReadableStream,
      ),
      '',
      [200],
      region,
    );
    const etag = response.headers.etag;
    response.resume();
    if (typeof etag !== 'string' || !etag.trim()) {
      throw new Error('multipart_part_etag_missing');
    }
    return { etag: etag.replace(/^"|"$/g, '') };
  }

  listMultipartParts(bucket: string, objectKey: string, uploadId: string) {
    return this.listParts(bucket, objectKey, uploadId);
  }

  findMultipartUpload(bucket: string, objectKey: string) {
    return this.findUploadId(bucket, objectKey);
  }
}

export class MinioMultipartFileStorage implements MultipartFileStorage {
  private readonly client: StreamingMultipartClient;

  constructor(options: {
    endpoint?: string;
    accessKey?: string;
    secretKey?: string;
    region?: string;
    ca?: string;
  } = {}) {
    const endpoint = new URL(options.endpoint ?? env.minio.endpoint);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error('multipart_minio_endpoint_invalid');
    }
    this.client = new StreamingMultipartClient({
      endPoint: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : undefined,
      useSSL: endpoint.protocol === 'https:',
      accessKey: options.accessKey ?? env.minio.accessKey,
      secretKey: options.secretKey ?? env.minio.secretKey,
      region: options.region ?? process.env.MINIO_REGION ?? 'us-east-1',
      ...(options.ca ?? env.minio.ca
        ? {
            transportAgent: new Agent({
              keepAlive: true,
              ca: options.ca ?? env.minio.ca,
              rejectUnauthorized: true,
            }),
          }
        : {}),
    });
  }

  async initiateMultipartUpload(
    bucket: string,
    objectKey: string,
    contentType: string,
  ) {
    try {
      return await this.client.initiateNewMultipartUpload(bucket, objectKey, {
        'Content-Type': contentType,
      });
    } catch {
      throw sanitizedMultipartError('initiate');
    }
  }

  async putMultipartPartStream(input: {
    bucket: string;
    objectKey: string;
    uploadId: string;
    partNumber: number;
    body: ReadableStream<Uint8Array>;
    contentLength: number;
  }) {
    try {
      return await this.client.putPartStream(input);
    } catch {
      throw sanitizedMultipartError('part_upload');
    }
  }

  async listMultipartParts(
    bucket: string,
    objectKey: string,
    uploadId: string,
  ): Promise<MultipartPart[]> {
    try {
      const parts = await this.client.listMultipartParts(bucket, objectKey, uploadId);
      return parts.map((part: MinioMultipartPart) => ({
        partNumber: part.part,
        sizeBytes: part.size,
        etag: part.etag,
      }));
    } catch {
      throw sanitizedMultipartError('list_parts');
    }
  }

  async completeMultipartUpload(
    bucket: string,
    objectKey: string,
    uploadId: string,
    parts: MultipartPart[],
  ) {
    try {
      await this.client.completeMultipartUpload(
        bucket,
        objectKey,
        uploadId,
        parts.map((part) => ({ part: part.partNumber, etag: part.etag })),
      );
    } catch {
      throw sanitizedMultipartError('complete');
    }
  }

  async abortMultipartUpload(bucket: string, objectKey: string, uploadId: string) {
    try {
      await this.client.abortMultipartUpload(bucket, objectKey, uploadId);
    } catch {
      throw sanitizedMultipartError('abort');
    }
  }

  async findMultipartUpload(bucket: string, objectKey: string) {
    try {
      return (await this.client.findMultipartUpload(bucket, objectKey)) ?? null;
    } catch {
      throw sanitizedMultipartError('find');
    }
  }
}
