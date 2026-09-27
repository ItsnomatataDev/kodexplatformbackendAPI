import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readAccessToken } from '../src/routes/chat-ws.js';
import {
  IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  postgresPoolConfig,
} from '../src/db/pool-config.js';
import { listLimit, ORGANIZATION_LIST_LIMIT } from '../src/db/list-bounds.js';
import { streamStoredMedia } from '../src/content/media-stream.js';
import type { FileStorage } from '../src/files/storage.js';

const database = {
  host: '127.0.0.1',
  port: 5432,
  name: 'kode_platform',
  user: 'kode',
  password: 'test',
  ssl: false,
  rejectUnauthorized: true,
};

test('websocket auth still reads the query access token', () => {
  const token = readAccessToken({
    req: {
      query: (name) => (name === 'access_token' ? 'ws-token' : undefined),
      header: () => undefined,
    },
  });
  assert.equal(token, 'ws-token');
});

test('websocket auth still reads the query token alias', () => {
  const token = readAccessToken({
    req: {
      query: (name) => (name === 'token' ? 'ws-alias' : undefined),
      header: () => undefined,
    },
  });
  assert.equal(token, 'ws-alias');
});

test('vps API binds loopback and data stores stay on loopback', () => {
  const vps = readFileSync(new URL('../docker-compose.vps.yml', import.meta.url), 'utf8');
  const apiBlock = vps.slice(vps.indexOf('  api:'));
  assert.match(apiBlock, /network_mode:\s*host/);
  assert.match(apiBlock, /HOST:\s*127\.0\.0\.1/);
  assert.doesNotMatch(apiBlock, /HOST:\s*0\.0\.0\.0/);
  assert.match(vps, /127\.0\.0\.1:5433:5432/);
  assert.match(vps, /127\.0\.0\.1:6379:6379/);
  assert.match(vps, /127\.0\.0\.1:9000:9000/);
  assert.match(vps, /127\.0\.0\.1:9001:9001/);

  const production = readFileSync(
    new URL('../docker-compose.production.example.yml', import.meta.url),
    'utf8',
  );
  assert.match(production, /HOST:\s*0\.0\.0\.0/);
  assert.doesNotMatch(production, /network_mode:\s*host/);
  const caddy = readFileSync(new URL('../deploy/Caddyfile.example', import.meta.url), 'utf8');
  assert.match(caddy, /reverse_proxy api:3000/);
});

test('postgres pool sets statement and idle-in-transaction timeouts', () => {
  const config = postgresPoolConfig(database);
  assert.equal(STATEMENT_TIMEOUT_MS, 30_000);
  assert.equal(IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS, 60_000);
  assert.equal(config.statement_timeout, 30_000);
  assert.equal(config.idle_in_transaction_session_timeout, 60_000);
  assert.equal(config.connectionTimeoutMillis, 5_000);
  assert.equal(config.max, 10);
});

test('capped organization lists keep their tenant predicate and a LIMIT', () => {
  const files = [
    ['src/tourism/postgres-store.ts', 'organization_id = $1'],
    ['src/social/postgres-store.ts', 'organization_id = $1'],
    ['src/content/postgres-store.ts', 'organization_id = $1'],
    ['src/security/postgres-store.ts', 'organization_id = $1'],
    ['src/fleet/postgres-store.ts', 'organization_id = $1'],
  ] as const;
  for (const [file, predicate] of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(predicate.replace(/[$.]/g, '\\$&')));
    assert.match(source, /LIMIT \$/);
  }
  const schedulesForClient = readFileSync(
    new URL('../src/content/postgres-store.ts', import.meta.url),
    'utf8',
  );
  assert.match(schedulesForClient, /WHERE client_id = \$1/);
});

test('organization list limit clamps to the server maximum', () => {
  assert.equal(listLimit(undefined), ORGANIZATION_LIST_LIMIT);
  assert.equal(listLimit(10_000), ORGANIZATION_LIST_LIMIT);
  assert.equal(listLimit(2), 2);
  assert.equal(ORGANIZATION_LIST_LIMIT, 200);
});

test('download path uses the stream API and does not call getObject', async () => {
  let getObjectCalls = 0;
  const files = {
    async getObject() {
      getObjectCalls += 1;
      throw new Error('whole object must not be buffered');
    },
    async getObjectStream() {
      return {
        bucket: 'files',
        objectKey: 'large.bin',
        contentType: 'application/octet-stream',
        sizeBytes: 6,
        contentLength: 6,
        contentRange: null,
        status: 200 as const,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        }),
      };
    },
  } as unknown as FileStorage;

  const response = await streamStoredMedia({
    files,
    bucket: 'files',
    objectKey: 'large.bin',
  });
  const bytes = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(getObjectCalls, 0);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6]);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
});
