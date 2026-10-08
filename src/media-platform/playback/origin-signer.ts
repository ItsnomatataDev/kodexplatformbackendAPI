import { Client } from 'minio';
import { Agent } from 'node:https';

export const MEDIA_ORIGIN_URL_TTL_SECONDS = 60;

export interface MediaOriginRequest {
  assetId: string;
  objectPath: string;
}

export interface MediaOriginSigner {
  sign(input: MediaOriginRequest): Promise<string>;
}

interface PresignedGetObjectClient {
  presignedGetObject(
    bucketName: string,
    objectName: string,
    expires?: number,
  ): Promise<string>;
}

export function mediaOriginObjectKey(
  assetId: string,
  objectPath: string,
): string {
  return `.media/v1/${assetId}/${objectPath}`;
}

export function createMediaOriginSigner(options: {
  client: PresignedGetObjectClient;
  bucket: string;
  ttlSeconds?: number;
}): MediaOriginSigner {
  const ttlSeconds =
    options.ttlSeconds ?? MEDIA_ORIGIN_URL_TTL_SECONDS;

  if (!options.bucket) {
    throw new Error('Media origin bucket is required');
  }

  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > 300
  ) {
    throw new Error('Invalid media origin URL TTL');
  }

  return {
    async sign(input) {
      const objectKey = mediaOriginObjectKey(
        input.assetId,
        input.objectPath,
      );

      return options.client.presignedGetObject(
        options.bucket,
        objectKey,
        ttlSeconds,
      );
    },
  };
}

export function createMinioOriginClient(options: {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  ca?: string;
}): Client {
  if (!options.accessKey || !options.secretKey) {
    throw new Error(
      'Media origin MinIO credentials are required',
    );
  }

  const endpoint = new URL(options.endpoint);

  if (
    (endpoint.protocol !== 'http:' &&
      endpoint.protocol !== 'https:') ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error('Invalid media origin MinIO endpoint');
  }

  const useSSL = endpoint.protocol === 'https:';

  return new Client({
    endPoint: endpoint.hostname,
    port: endpoint.port
      ? Number(endpoint.port)
      : useSSL
        ? 443
        : 80,
    useSSL,
    region: 'us-east-1',
    accessKey: options.accessKey,
    secretKey: options.secretKey,
    ...(useSSL
      ? {
          transportAgent: new Agent({
            keepAlive: true,
            ca: options.ca,
          }),
        }
      : {}),
  });
}
