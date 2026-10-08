import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { createHash } from 'node:crypto';
import { verifyMediaEdgeRequest } from './edge-auth.js';
import {
  createMediaOriginSigner,
  createMinioOriginClient,
  type MediaOriginSigner,
} from './origin-signer.js';

const DEFAULT_PORT = 3200;

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return DEFAULT_PORT;
  }

  const port = Number(value);

  if (
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65535
  ) {
    throw new Error('Invalid MEDIA_AUTH_PORT');
  }

  return port;
}

function send(
  response: ServerResponse,
  statusCode: number,
): void {
  response.statusCode = statusCode;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', '0');
  response.end();
}

function requestUri(
  request: IncomingMessage,
): string | null {
  const value = request.headers['x-original-uri'];

  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  return value;
}

export function createMediaAuthServer(
  secret: string,
  originSigner?: MediaOriginSigner,
) {
  if (!secret) {
    throw new Error(
      'MEDIA_PLAYBACK_SIGNING_SECRET is required',
    );
  }

  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (request, response) => {
    if (request.method !== 'GET') {
      send(response, 405);
      return;
    }

    if (request.url !== '/authorize') {
      send(response, 404);
      return;
    }

    const uri = requestUri(request);

    if (uri === null) {
      send(response, 400);
      return;
    }

    const verification = verifyMediaEdgeRequest({
      uri,
      secret,
    });

    if (!verification.valid) {
      send(response, 403);
      return;
    }

    response.setHeader(
      'X-Media-Asset-Id',
      verification.assetId,
    );

    response.setHeader(
      'X-Media-Object-Path',
      verification.objectPath,
    );

    if (originSigner) {
      try {
        const originUrl = await originSigner.sign({
          assetId: verification.assetId,
          objectPath: verification.objectPath,
        });

        const parsedOriginUrl = new URL(originUrl);

        if (
          parsedOriginUrl.protocol !== 'http:' &&
          parsedOriginUrl.protocol !== 'https:'
        ) {
          throw new Error(
            'Origin signer returned an invalid protocol',
          );
        }

        response.setHeader('X-Media-Cache-Key', createHash('sha256')
          .update(`${parsedOriginUrl.origin}${parsedOriginUrl.pathname}`).digest('hex'));

        response.setHeader(
          'X-Media-Origin-URI',
          `${parsedOriginUrl.pathname}${parsedOriginUrl.search}`,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'media.auth.origin_sign_failed',
            code: 'origin_sign_failed',
          }),
        );

        send(response, 503);
        return;
      }
    }

    send(response, 204);
  });
}

function main(): void {
  const secret =
    process.env.MEDIA_PLAYBACK_SIGNING_SECRET ?? '';

  const port = parsePort(
    process.env.MEDIA_AUTH_PORT,
  );

  const minioEndpoint =
    process.env.MEDIA_ORIGIN_ENDPOINT ?? '';

  const minioBucket =
    process.env.MEDIA_ORIGIN_BUCKET ?? '';

  const minioAccessKey =
    process.env.MEDIA_ORIGIN_ACCESS_KEY ?? '';

  const minioSecretKey =
    process.env.MEDIA_ORIGIN_SECRET_KEY ?? '';

  if (!minioEndpoint) {
    throw new Error('MEDIA_ORIGIN_ENDPOINT is required');
  }

  if (!minioBucket) {
    throw new Error('MEDIA_ORIGIN_BUCKET is required');
  }

  const minioClient = createMinioOriginClient({
    endpoint: minioEndpoint,
    accessKey: minioAccessKey,
    secretKey: minioSecretKey,
  });

  const originSigner = createMediaOriginSigner({
    client: minioClient,
    bucket: minioBucket,
  });

  const server = createMediaAuthServer(
    secret,
    originSigner,
  );

  server.listen(port, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        event: 'media.auth.ready',
        port,
      }),
    );
  });

  const shutdown = () => {
    server.close((error) => {
      if (error) {
        console.error(
          JSON.stringify({
            event: 'media.auth.shutdown_failed',
            error: error.message,
          }),
        );

        process.exitCode = 1;
        return;
      }

      process.exitCode = 0;
    });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (
  process.argv[1] &&
  import.meta.url ===
    new URL(
      `file://${process.argv[1]}`,
    ).href
) {
  main();
}
