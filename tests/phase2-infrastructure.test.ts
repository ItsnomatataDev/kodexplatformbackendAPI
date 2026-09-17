import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisRateLimiter, redisClientOptions } from '../src/auth/rate-limit-redis.js';
import {
  assertInfrastructureSecurity,
  minioEndpointUsesHttps,
  redisRateLimitKey,
  redisRateLimitPrefix,
  type InfrastructureSecurityInput,
} from '../src/config/infrastructure-security.js';
import { postgresPoolConfig } from '../src/db/pool-config.js';
import { ServiceUnavailableError } from '../src/http/errors.js';
import { MemoryBoardStore } from '../src/work/memory-store.js';
import {
  bearer,
  createBoard,
  createCard,
  createColumn,
  createWorkApp,
  json,
  userA,
  userB,
} from './work-harness.js';

function productionSecurity(
  overrides: Partial<{
    database: Partial<InfrastructureSecurityInput['database']>;
    redis: Partial<InfrastructureSecurityInput['redis']>;
    minio: Partial<InfrastructureSecurityInput['minio']>;
    trustedProxyIps: string[];
  }> = {},
): InfrastructureSecurityInput {
  return {
    appEnv: 'production',
    database: {
      host: 'production-postgres',
      ssl: true,
      rejectUnauthorized: true,
      password: 'not-a-placeholder-secret',
      ...overrides.database,
    },
    redis: {
      host: 'production-redis',
      tls: true,
      rejectUnauthorized: true,
      password: 'not-a-placeholder-secret',
      ...overrides.redis,
    },
    minio: {
      endpoint: 'https://production-minio:9000',
      accessKey: 'not-a-placeholder-secret',
      secretKey: 'not-a-placeholder-secret',
      ...overrides.minio,
    },
    trustedProxyIps: overrides.trustedProxyIps ?? ['10.0.0.1'],
  };
}

function stagingSecurity(
  overrides: Partial<{
    database: Partial<InfrastructureSecurityInput['database']>;
    redis: Partial<InfrastructureSecurityInput['redis']>;
    minio: Partial<InfrastructureSecurityInput['minio']>;
    trustedProxyIps: string[];
  }> = {},
): InfrastructureSecurityInput {
  return {
    appEnv: 'staging',
    database: {
      host: 'staging-postgres',
      ssl: true,
      rejectUnauthorized: true,
      password: 'not-a-placeholder-secret',
      ...overrides.database,
    },
    redis: {
      host: 'staging-redis',
      tls: true,
      rejectUnauthorized: true,
      password: 'not-a-placeholder-secret',
      ...overrides.redis,
    },
    minio: {
      endpoint: 'https://staging-minio:9000',
      accessKey: 'not-a-placeholder-secret',
      secretKey: 'not-a-placeholder-secret',
      ...overrides.minio,
    },
    trustedProxyIps: overrides.trustedProxyIps ?? ['10.0.0.1'],
  };
}

test('PB-03 rate-limit prefixes are environment-specific', () => {
  assert.equal(redisRateLimitPrefix('development'), 'kode:development:ratelimit:');
  assert.equal(redisRateLimitPrefix('staging'), 'kode:staging:ratelimit:');
  assert.equal(redisRateLimitPrefix('production'), 'kode:production:ratelimit:');
  assert.notEqual(
    redisRateLimitKey('development', 'login:ip:1.1.1.1'),
    redisRateLimitKey('production', 'login:ip:1.1.1.1'),
  );
  assert.equal(
    redisRateLimitKey('staging', 'login:ip:1.1.1.1').includes('password'),
    false,
  );
});

test('PB-03 development Redis may omit auth and TLS', () => {
  assert.doesNotThrow(() =>
    assertInfrastructureSecurity({
      appEnv: 'development',
      database: {
        host: '127.0.0.1',
        ssl: false,
        rejectUnauthorized: true,
        password: 'kode_dev_password',
      },
      redis: {
        host: '127.0.0.1',
        tls: false,
        rejectUnauthorized: true,
        password: '',
      },
      minio: {
        endpoint: 'http://127.0.0.1:9000',
        accessKey: 'kode_dev',
        secretKey: 'kode_dev_minio_password',
      },
      trustedProxyIps: [],
    }),
  );
});

test('PB-03 staging remote Redis requires auth and TLS', () => {
  assert.doesNotThrow(() => assertInfrastructureSecurity(stagingSecurity()));
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        stagingSecurity({
          redis: { tls: false, password: 'not-a-placeholder-secret' },
        }),
      ),
    /REDIS_TLS=true/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        stagingSecurity({
          redis: { tls: true, password: 'change_me' },
        }),
      ),
    /REDIS_PASSWORD/,
  );
});

test('PB-03 production Redis requires auth, TLS, and rejects loopback', () => {
  assert.doesNotThrow(() => assertInfrastructureSecurity(productionSecurity()));
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ redis: { password: '' } }),
      ),
    /REDIS_PASSWORD/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ redis: { tls: false } }),
      ),
    /REDIS_TLS=true/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ redis: { host: '127.0.0.1' } }),
      ),
    /loopback/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ redis: { host: 'localhost' } }),
      ),
    /loopback/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ redis: { rejectUnauthorized: false } }),
      ),
    /certificate verification/,
  );
});

test('PB-03 Redis limiter uses the environment prefix and fails closed', async () => {
  const keys: string[] = [];
  let captured: ReturnType<typeof redisClientOptions> | undefined;
  const client = {
    isOpen: true,
    async connect() {
      return undefined;
    },
    async incr(key: string) {
      keys.push(key);
      return 1;
    },
    async expire() {
      return true;
    },
    async ttl() {
      return 60;
    },
    async close() {},
  };

  const limiter = new RedisRateLimiter({
    appEnv: 'staging',
    host: 'staging-redis',
    port: 6379,
    password: 'secret',
    tls: true,
    rejectUnauthorized: true,
    createClient: (options) => {
      captured = options;
      return client;
    },
  });

  await limiter.consume('login:ip:203.0.113.10', 10, 900);
  assert.equal(keys[0], 'kode:staging:ratelimit:login:ip:203.0.113.10');
  assert.equal(captured?.password, 'secret');
  assert.equal(Boolean(captured?.socket && 'tls' in captured.socket), true);
  await limiter.close();

  const failing = new RedisRateLimiter({
    appEnv: 'production',
    host: 'production-redis',
    port: 6379,
    password: 'secret',
    tls: true,
    rejectUnauthorized: true,
    createClient: () => {
      throw new Error('ECONNREFUSED');
    },
  });

  await assert.rejects(
    () => failing.consume('login:ip:203.0.113.10', 10, 900),
    (error: unknown) => {
      assert.equal(error instanceof ServiceUnavailableError, true);
      assert.equal((error as ServiceUnavailableError).code, 'RATE_LIMIT_UNAVAILABLE');
      return true;
    },
  );
  await failing.close();

  assert.throws(
    () =>
      new RedisRateLimiter({
        appEnv: 'production',
        host: 'production-redis',
        port: 6379,
        password: 'secret',
        tls: true,
        rejectUnauthorized: false,
      }),
    /cannot disable certificate verification/,
  );
});

test('PB-08 PostgreSQL TLS is required in production and used by the pool/migration config', () => {
  const production = postgresPoolConfig({
    host: 'production-postgres',
    port: 5432,
    name: 'kode_platform_production',
    user: 'kode_production',
    password: 'not-a-placeholder-secret',
    ssl: true,
    rejectUnauthorized: true,
    ca: '-----BEGIN CERTIFICATE-----test-----END CERTIFICATE-----',
  });
  assert.equal(typeof production.ssl, 'object');
  assert.equal(
    production.ssl && typeof production.ssl === 'object'
      ? production.ssl.rejectUnauthorized
      : false,
    true,
  );

  const development = postgresPoolConfig({
    host: '127.0.0.1',
    port: 5433,
    name: 'kode_platform',
    user: 'kode',
    password: 'kode_dev_password',
    ssl: false,
    rejectUnauthorized: true,
  });
  assert.equal(development.ssl, undefined);

  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ database: { ssl: false } }),
      ),
    /DATABASE_SSL=true/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ database: { host: '127.0.0.1' } }),
      ),
    /loopback/,
  );
  assert.doesNotThrow(() =>
    assertInfrastructureSecurity(
      stagingSecurity({
        database: { ssl: true },
      }),
    ),
  );
});

test('PB-08 staging loopback may omit TLS while remote staging cannot', () => {
  assert.doesNotThrow(() =>
    assertInfrastructureSecurity({
      appEnv: 'staging',
      database: {
        host: '127.0.0.1',
        ssl: false,
        rejectUnauthorized: true,
        password: 'staging-local',
      },
      redis: {
        host: 'localhost',
        tls: false,
        rejectUnauthorized: true,
        password: '',
      },
      minio: {
        endpoint: 'http://127.0.0.1:9000',
        accessKey: 'staging-local',
        secretKey: 'staging-local',
      },
      trustedProxyIps: [],
    }),
  );
});

test('PB-07 staging and production reject known development credentials without printing them', () => {
  const developmentSecret = 'kode_dev_password';

  assert.doesNotThrow(() =>
    assertInfrastructureSecurity({
      appEnv: 'development',
      database: {
        host: '127.0.0.1',
        ssl: false,
        rejectUnauthorized: true,
        password: developmentSecret,
      },
      redis: {
        host: '127.0.0.1',
        tls: false,
        rejectUnauthorized: true,
        password: '',
      },
      minio: {
        endpoint: 'http://127.0.0.1:9000',
        accessKey: 'kode_dev',
        secretKey: 'kode_dev_minio_password',
      },
      trustedProxyIps: [],
    }),
  );

  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ database: { password: developmentSecret } }),
      ),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const message = (error as Error).message;
      assert.match(message, /DATABASE_PASSWORD/);
      assert.match(message, /known development secret/);
      assert.equal(message.includes(developmentSecret), false);
      return true;
    },
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        stagingSecurity({
          minio: { accessKey: 'kode_dev', secretKey: 'not-a-placeholder-secret' },
        }),
      ),
    /MINIO_ACCESS_KEY/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({
          minio: {
            accessKey: 'not-a-placeholder-secret',
            secretKey: 'kode_dev_minio_password',
          },
        }),
      ),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /MINIO_SECRET_KEY/);
      assert.equal(message.includes('kode_dev_minio_password'), false);
      return true;
    },
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ database: { password: 'change_me' } }),
      ),
    /non-placeholder secret/,
  );
});

test('PB-10 MinIO production requires HTTPS and real credentials', () => {
  assert.equal(minioEndpointUsesHttps('http://127.0.0.1:9000'), false);
  assert.equal(minioEndpointUsesHttps('https://production-minio:9000'), true);

  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({
          minio: { endpoint: 'http://production-minio:9000' },
        }),
      ),
    /https:\/\//,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({
          minio: { accessKey: 'change_me', secretKey: 'not-a-placeholder-secret' },
        }),
      ),
    /MINIO_ACCESS_KEY/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({
          minio: {
            accessKey: 'not-a-placeholder-secret',
            secretKey: 'REPLACE_WITH_RUNTIME_SECRET',
          },
        }),
      ),
    /MINIO_SECRET_KEY/,
  );
  assert.throws(
    () =>
      assertInfrastructureSecurity(
        productionSecurity({ trustedProxyIps: ['0.0.0.0/0'] }),
      ),
    /cannot trust every address/,
  );
});

test('PB-10 attachment content stays behind API authorization', async () => {
  const store = new MemoryBoardStore();
  const app = createWorkApp(store);
  const boardA = await createBoard(app, userA, 'Board A');
  const columnA = await createColumn(app, userA, boardA, 'To Do');
  const cardA = await createCard(app, userA, boardA, columnA, 'Card A');
  const boardB = await createBoard(app, userB, 'Board B');
  const columnB = await createColumn(app, userB, boardB, 'To Do');
  const cardB = await createCard(app, userB, boardB, columnB, 'Card B');

  const created = await json(
    await app.request(`/api/cards/${cardB.id}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: await bearer(userB),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'secret.txt',
        contentBase64: Buffer.from('secret').toString('base64'),
      }),
    }),
  );

  const stolen = await json(
    await app.request(`/api/attachments/${created.attachment.id}/content`, {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(stolen.error?.code, 'ATTACHMENT_NOT_FOUND');

  const mismatch = await json(
    await app.request(
      `/api/cards/${cardA.id}/attachments/${created.attachment.id}`,
      {
        headers: { Authorization: await bearer(userA) },
      },
    ),
  );
  assert.equal(mismatch.error?.code, 'ATTACHMENT_NOT_FOUND');
});
