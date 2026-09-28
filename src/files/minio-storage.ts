import { createHash, createHmac } from 'node:crypto';
import https from 'node:https';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { ServiceUnavailableError } from '../http/errors.js';
import type {
  FileStorage,
  ObjectHead,
  ObjectStreamResult,
  PutObjectInput,
  PutObjectStreamInput,
  StoredObject,
} from './storage.js';

function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hashHex(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function encodeKey(objectKey: string) {
  return objectKey
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function headerNumber(headers: Headers, name: string) {
  const raw = headers.get(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export class MinioFileStorage implements FileStorage {
  private readonly ensuredBuckets = new Set<string>();

  constructor(
    private readonly options: {
      endpoint: string;
      accessKey: string;
      secretKey: string;
      region?: string;
      ca?: string;
    } = {
      endpoint: env.minio.endpoint,
      accessKey: env.minio.accessKey,
      secretKey: env.minio.secretKey,
      ca: env.minio.ca,
    },
  ) {}

  async putObject(input: PutObjectInput) {
    const response = await this.request('PUT', input.bucket, input.objectKey, input.body, {
      'content-type': input.contentType ?? 'application/octet-stream',
    });
    if (!response.ok) {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        `Object storage rejected upload (HTTP ${response.status}).`,
      );
    }
  }

  async putObjectStream(input: PutObjectStreamInput) {
    const contentType = input.contentType ?? 'application/octet-stream';
    if (Buffer.isBuffer(input.body)) {
      await this.putObject({
        bucket: input.bucket,
        objectKey: input.objectKey,
        body: input.body,
        contentType,
      });
      return;
    }

    const response = await this.request(
      'PUT',
      input.bucket,
      input.objectKey,
      input.body,
      {
        'content-type': contentType,
        'content-length': String(input.contentLength),
      },
      UNSIGNED_PAYLOAD,
    );
    if (!response.ok) {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        `Object storage rejected upload (HTTP ${response.status}).`,
      );
    }
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

  async headObject(bucket: string, objectKey: string): Promise<ObjectHead | null> {
    const response = await this.request('HEAD', bucket, objectKey);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is unavailable.',
      );
    }
    return {
      bucket,
      objectKey,
      contentType: response.headers.get('content-type'),
      sizeBytes: headerNumber(response.headers, 'content-length'),
    };
  }

  async getObjectStream(
    bucket: string,
    objectKey: string,
    rangeHeader?: string | null,
  ): Promise<ObjectStreamResult | null> {
    const extraHeaders: Record<string, string> = {};
    if (rangeHeader?.trim()) {
      extraHeaders.range = rangeHeader.trim();
    }

    const response = await this.request(
      'GET',
      bucket,
      objectKey,
      undefined,
      extraHeaders,
      undefined,
      { streamBody: true },
    );

    if (response.status === 404) {
      return null;
    }

    if (response.status === 416) {
      return {
        bucket,
        objectKey,
        contentType: response.headers.get('content-type'),
        sizeBytes: (() => {
          const contentRange = response.headers.get('content-range');
          const match = contentRange?.match(/\/(\d+)\s*$/);
          return match ? Number(match[1]) : headerNumber(response.headers, 'content-length');
        })(),
        contentLength: 0,
        contentRange: response.headers.get('content-range'),
        status: 416,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      };
    }

    if (response.status !== 200 && response.status !== 206) {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        `Object storage rejected download (HTTP ${response.status}).`,
      );
    }

    if (!response.body) {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage returned an empty body.',
      );
    }

    const contentRange = response.headers.get('content-range');
    const contentLength = headerNumber(response.headers, 'content-length');
    let sizeBytes = headerNumber(response.headers, 'content-length');
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)\s*$/);
      if (match) sizeBytes = Number(match[1]);
    }

    return {
      bucket,
      objectKey,
      contentType: response.headers.get('content-type'),
      sizeBytes,
      contentLength,
      contentRange,
      status: response.status === 206 ? 206 : 200,
      body: response.body,
    };
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

  /** Read-only bucket probe. Does not create buckets. */
  async headBucket(bucket: string): Promise<number> {
    const response = await this.request('HEAD', bucket, '');
    return response.status;
  }

  async ensureBucket(bucket: string) {
    if (this.ensuredBuckets.has(bucket)) return;

    const head = await this.request('HEAD', bucket, '');
    if (head.status === 200) {
      this.ensuredBuckets.add(bucket);
      return;
    }

    const created = await this.request('PUT', bucket, '');
    if (
      created.status === 200 ||
      created.status === 201 ||
      // Already owned / exists
      created.status === 409
    ) {
      this.ensuredBuckets.add(bucket);
      return;
    }

    throw new ServiceUnavailableError(
      'OBJECT_STORAGE_UNAVAILABLE',
      `Could not ensure storage bucket "${bucket}" (HTTP ${created.status}).`,
    );
  }

  private async request(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    bucket: string,
    objectKey: string,
    body?: Buffer | ReadableStream<Uint8Array>,
    extraHeaders: Record<string, string> = {},
    payloadHashOverride?: string,
    options?: { streamBody?: boolean },
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
    const isStream = body != null && !Buffer.isBuffer(body);
    const bufferBody = Buffer.isBuffer(body) ? body : undefined;
    const payloadHash =
      payloadHashOverride ??
      (isStream ? UNSIGNED_PAYLOAD : hashHex(bufferBody ?? Buffer.alloc(0)));
    const canonicalUri = objectKey
      ? `/${bucket}/${encodeKey(objectKey)}`
      : `/${bucket}`;
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };

    if (bufferBody) {
      headers['content-length'] = String(bufferBody.byteLength);
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
      return await this.dispatch(
        `${url.origin}${canonicalUri}`,
        {
          method,
          headers,
          body: method === 'PUT' ? (body ?? undefined) : undefined,
        },
        { streamBody: options?.streamBody === true },
      );
    } catch {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is unavailable.',
      );
    }
  }

  private async dispatch(
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: Buffer | ReadableStream<Uint8Array>;
    },
    options?: { streamBody?: boolean },
  ): Promise<Response> {
    if (!this.options.ca) {
      return fetch(url, {
        method: init.method,
        headers: init.headers,
        // Node fetch requires duplex when streaming a request body.
        ...(init.body && !Buffer.isBuffer(init.body)
          ? { body: init.body, duplex: 'half' as const }
          : {
              body: init.body ? new Uint8Array(init.body) : undefined,
            }),
      } as RequestInit);
    }

    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new ServiceUnavailableError(
        'OBJECT_STORAGE_UNAVAILABLE',
        'Object storage is unavailable.',
      );
    }

    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          method: init.method,
          headers: init.headers,
          ca: this.options.ca,
          rejectUnauthorized: true,
        },
        (response) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') {
              headers.set(name, value);
            } else if (Array.isArray(value)) {
              headers.set(name, value.join(', '));
            }
          }

          if (options?.streamBody) {
            resolve(
              new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
                status: response.statusCode ?? 500,
                headers,
              }),
            );
            return;
          }

          const chunks: Buffer[] = [];
          response.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                headers,
              }),
            );
          });
        },
      );

      request.on('error', reject);
      if (!init.body) {
        request.end();
        return;
      }

      if (Buffer.isBuffer(init.body)) {
        request.write(init.body);
        request.end();
        return;
      }

      Readable.fromWeb(init.body as import('node:stream/web').ReadableStream)
        .pipe(request);
    });
  }
}
