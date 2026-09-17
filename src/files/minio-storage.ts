import { createHash, createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { ServiceUnavailableError } from '../http/errors.js';
import type { FileStorage, PutObjectInput, StoredObject } from './storage.js';

function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hashHex(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function encodeKey(objectKey: string) {
  return objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export class MinioFileStorage implements FileStorage {
  constructor(
    private readonly options: {
      endpoint: string;
      accessKey: string;
      secretKey: string;
      region?: string;
    } = {
      endpoint: env.minio.endpoint,
      accessKey: env.minio.accessKey,
      secretKey: env.minio.secretKey,
    },
  ) {}

  async putObject(input: PutObjectInput) {
    await this.request('PUT', input.bucket, input.objectKey, input.body, {
      'content-type': input.contentType ?? 'application/octet-stream',
    });
  }

  async getObject(bucket: string, objectKey: string) {
    const response = await this.request('GET', bucket, objectKey);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is unavailable.',
      );
    }

    const body = Buffer.from(await response.arrayBuffer());
    return {
      bucket,
      objectKey,
      contentType: response.headers.get('content-type'),
      sizeBytes: body.byteLength,
      checksum: hashHex(body),
      body,
    } satisfies StoredObject;
  }

  async deleteObject(bucket: string, objectKey: string) {
    const response = await this.request('DELETE', bucket, objectKey);
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is unavailable.',
      );
    }
  }

  private async request(
    method: 'GET' | 'PUT' | 'DELETE',
    bucket: string,
    objectKey: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ) {
    if (!this.options.accessKey || !this.options.secretKey) {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is not configured.',
      );
    }

    const url = new URL(this.options.endpoint);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const region = this.options.region ?? 'us-east-1';
    const payload = body ?? Buffer.alloc(0);
    const payloadHash = hashHex(payload);
    const canonicalUri = `/${bucket}/${encodeKey(objectKey)}`;
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };

    if (body) {
      headers['content-length'] = String(body.byteLength);
    }

    const signedHeaderNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${headers[name]}\n`)
      .join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hashHex(canonicalRequest),
    ].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.options.secretKey}`, dateStamp), region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      return await fetch(`${url.origin}${canonicalUri}`, {
        method,
        headers,
        body: method === 'PUT' ? new Uint8Array(payload) : undefined,
      });
    } catch {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is unavailable.',
      );
    }
  }
}
