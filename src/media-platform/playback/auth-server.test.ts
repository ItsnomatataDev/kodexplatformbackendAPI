import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { createMediaPlaybackSignature } from './token.js';
import { createMediaAuthServer } from './auth-server.js';
import { MemoryPlaybackGrantStore } from './redis-grant.js';
import { verifyMediaEdgeRequest } from './edge-auth.js';
import { ServiceUnavailableError } from '../../http/errors.js';

const SECRET = 'test-only-media-playback-secret';

const ASSET_ID =
  '0c8176a7-87c6-4f97-bf09-6c1fcf32acce';

const NOW = Math.floor(Date.now() / 1000);
const EXPIRES_AT = NOW + 3600;

const VALID_SIGNATURE = createMediaPlaybackSignature(
  {
    assetId: ASSET_ID,
    expiresAt: EXPIRES_AT,
  },
  SECRET,
);

function validUri(): string {
  return (
    `/media/v1/${EXPIRES_AT}/${VALID_SIGNATURE}/` +
    `${ASSET_ID}/hls/master.m3u8`
  );
}

const ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-1111-1111-111111111111';

async function issueGrant(
  store: MemoryPlaybackGrantStore,
  uri: string,
) {
  const verified = verifyMediaEdgeRequest({ uri, secret: SECRET });
  if (!verified.valid) return;
  await store.issue(
    {
      signature: verified.signature,
      assetId: verified.assetId,
      generation: verified.generation ?? null,
      organizationId: ORG_ID,
      userId: USER_ID,
      expiresAt: verified.expiresAt,
    },
    300_000,
  );
}

async function withServer(
  callback: (baseUrl: string, grants: MemoryPlaybackGrantStore) => Promise<void>,
  grants = new MemoryPlaybackGrantStore(),
  options: { issue?: boolean } = {},
): Promise<void> {
  if (options.issue !== false) {
    await issueGrant(grants, validUri());
  }
  const server = createMediaAuthServer(SECRET, undefined, 'http://minio:9000', grants);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;

    await callback(
      `http://127.0.0.1:${address.port}`,
      grants,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test('returns 204 for a valid signed media request', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/authorize`,
      {
        headers: {
          'X-Original-URI': validUri(),
        },
      },
    );

    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get('x-media-asset-id'),
      ASSET_ID,
    );
    assert.equal(
      response.headers.get('x-media-object-path'),
      'hls/master.m3u8',
    );
    assert.equal(
      response.headers.get('cache-control'),
      'no-store',
    );
  });
});

test('returns 403 for a tampered signed media request', async () => {
  await withServer(async (baseUrl) => {
    const uri = validUri().replace(
      '/hls/master.m3u8',
      '/hls/../original/video.mp4',
    );

    const response = await fetch(
      `${baseUrl}/authorize`,
      {
        headers: {
          'X-Original-URI': uri,
        },
      },
    );

    assert.equal(response.status, 403);
  });
});

test('returns 400 when X-Original-URI is missing', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/authorize`,
    );

    assert.equal(response.status, 400);
  });
});

test('returns 404 for an unknown auth route', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/wrong`,
      {
        headers: {
          'X-Original-URI': validUri(),
        },
      },
    );

    assert.equal(response.status, 404);
  });
});

test('returns 405 for non-GET requests', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/authorize`,
      {
        method: 'POST',
        headers: {
          'X-Original-URI': validUri(),
        },
      },
    );

    assert.equal(response.status, 405);
  });
});

test('refuses to create a server without a secret', () => {
  assert.throws(
    () => createMediaAuthServer(''),
    /MEDIA_PLAYBACK_SIGNING_SECRET is required/,
  );
});

async function withOriginServer(
  signer: {
    sign(input: {
      assetId: string;
      objectPath: string;
    }): Promise<string>;
  },
  callback: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const grants = new MemoryPlaybackGrantStore();
  await issueGrant(grants, validUri());
  const server = createMediaAuthServer(
    SECRET,
    signer,
    'http://minio:9000',
    grants,
  );

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;

    await callback(
      `http://127.0.0.1:${address.port}`,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test('returns the signed private origin URI for a valid request', async () => {
  const calls: Array<{
    assetId: string;
    objectPath: string;
  }> = [];

  await withOriginServer(
    {
      async sign(input) {
        calls.push(input);

        return (
          'http://minio:9000/' +
          'content-review-assets/' +
          `.media/v1/${input.assetId}/` +
          `${input.objectPath}` +
          '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
          '&X-Amz-Signature=test-signature'
        );
      },
    },
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/authorize`,
        {
          headers: {
            'X-Original-URI': validUri(),
          },
        },
      );

      assert.equal(response.status, 204);

      assert.deepEqual(calls, [
        {
          assetId: ASSET_ID,
          objectPath: 'hls/master.m3u8',
        },
      ]);

      const originUri = response.headers.get(
        'x-media-origin-uri',
      );

      assert.ok(originUri);

      assert.equal(
        originUri,
        `/content-review-assets/.media/v1/${ASSET_ID}/` +
          'hls/master.m3u8' +
          '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
          '&X-Amz-Signature=test-signature',
      );

      assert.equal(
        originUri.includes('minio:9000'),
        false,
      );
    },
  );
});

test('does not call the origin signer for an invalid media request', async () => {
  let calls = 0;

  await withOriginServer(
    {
      async sign() {
        calls += 1;
        return 'http://minio:9000/should-not-be-used';
      },
    },
    async (baseUrl) => {
      const uri = validUri().replace(
        '/hls/master.m3u8',
        '/hls/private.txt',
      );

      const response = await fetch(
        `${baseUrl}/authorize`,
        {
          headers: {
            'X-Original-URI': uri,
          },
        },
      );

      assert.equal(response.status, 403);
      assert.equal(calls, 0);

      assert.equal(
        response.headers.get('x-media-origin-uri'),
        null,
      );
    },
  );
});

test('fails closed when origin signing fails', async () => {
  await withOriginServer(
    {
      async sign() {
        throw new Error('simulated origin failure');
      },
    },
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/authorize`,
        {
          headers: {
            'X-Original-URI': validUri(),
          },
        },
      );

      assert.equal(response.status, 503);

      assert.equal(
        response.headers.get('x-media-origin-uri'),
        null,
      );
    },
  );
});

test('fails closed when the origin signer returns a non-http URL', async () => {
  await withOriginServer(
    {
      async sign() {
        return 'file:///etc/passwd';
      },
    },
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/authorize`,
        {
          headers: {
            'X-Original-URI': validUri(),
          },
        },
      );

      assert.equal(response.status, 503);

      assert.equal(
        response.headers.get('x-media-origin-uri'),
        null,
      );
    },
  );
});

test('never exposes the origin host in the authorization response', async () => {
  await withOriginServer(
    {
      async sign(input) {
        return (
          'http://minio:9000/' +
          'content-review-assets/' +
          `.media/v1/${input.assetId}/` +
          `${input.objectPath}` +
          '?X-Amz-Signature=internal-only'
        );
      },
    },
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/authorize`,
        {
          headers: {
            'X-Original-URI': validUri(),
          },
        },
      );

      assert.equal(response.status, 204);

      const originUri =
        response.headers.get('x-media-origin-uri');

      assert.ok(originUri);
      assert.equal(originUri.includes('minio'), false);
      assert.equal(
        originUri.startsWith('/content-review-assets/'),
        true,
      );
    },
  );
});

test('cache identity is stable across token renewal and differs for distinct objects', async () => {
  await withOriginServer({ async sign(input) {
    return `http://minio:9000/content-review-assets/.media/v1/${input.assetId}/${input.objectPath}?X-Amz-Signature=${Math.random()}`;
  } }, async (baseUrl) => {
    const authorize = (uri: string) => fetch(`${baseUrl}/authorize`, {headers: {'X-Original-URI':uri}});
    const first = await authorize(validUri());
    const next = await authorize(validUri());
    const other = await authorize(validUri().replace('master.m3u8','720p/index.m3u8'));
    const key = first.headers.get('x-media-cache-key');
    assert.match(key ?? '', /^[a-f0-9]{64}$/);
    assert.equal(next.headers.get('x-media-cache-key'), key);
    assert.notEqual(other.headers.get('x-media-cache-key'), key);
  });
});

test('rejects a signer authority that does not match the edge Host', async () => {
  await withOriginServer({async sign() { return 'http://other-origin:9000/private?X-Amz-Signature=hidden'; }}, async baseUrl => {
    const response = await fetch(`${baseUrl}/authorize`, {headers: {'X-Original-URI':validUri()}});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-media-origin-uri'), null);
    assert.equal(response.headers.get('x-media-cache-key'), null);
  });
});

test('denies a valid HMAC when the Redis grant is missing', async () => {
  const grants = new MemoryPlaybackGrantStore();
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/authorize`, {
      headers: { 'X-Original-URI': validUri() },
    });
    assert.equal(response.status, 403);
  }, grants, { issue: false });
});

test('denies playback after the user grant is revoked', async () => {
  await withServer(async (baseUrl, grants) => {
    const allowed = await fetch(`${baseUrl}/authorize`, {
      headers: { 'X-Original-URI': validUri() },
    });
    assert.equal(allowed.status, 204);
    await grants.revokeUser(USER_ID);
    const denied = await fetch(`${baseUrl}/authorize`, {
      headers: { 'X-Original-URI': validUri() },
    });
    assert.equal(denied.status, 403);
  });
});

test('fails closed when grant storage is unavailable', async () => {
  const grants = {
    async issue() {},
    async get() {
      throw new ServiceUnavailableError('MEDIA_PLAYBACK_UNAVAILABLE');
    },
    async revokeUser() {},
  };
  const server = createMediaAuthServer(SECRET, undefined, 'http://minio:9000', grants);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/authorize`, {
      headers: { 'X-Original-URI': validUri() },
    });
    assert.equal(response.status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
