import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertEnvironmentIsolation,
  hostnameOf,
  isLoopbackHost,
  type EnvironmentIsolationInput,
} from '../src/config/environment-guards.js';
import { parseAppEnvironment } from '../src/config/environments.js';

type IsolationOverrides = {
  appEnv?: EnvironmentIsolationInput['appEnv'];
  nodeEnv?: string;
  allowProduction?: boolean;
  host?: string;
  database?: Partial<EnvironmentIsolationInput['database']>;
  redis?: Partial<EnvironmentIsolationInput['redis']>;
  minio?: Partial<EnvironmentIsolationInput['minio']>;
};

function mergeConfig(
  base: EnvironmentIsolationInput,
  overrides: IsolationOverrides = {},
): EnvironmentIsolationInput {
  return {
    appEnv: overrides.appEnv ?? base.appEnv,
    nodeEnv: overrides.nodeEnv ?? base.nodeEnv,
    allowProduction: overrides.allowProduction ?? base.allowProduction,
    host: overrides.host ?? base.host,
    database: {
      ...base.database,
      ...overrides.database,
    },
    redis: {
      ...base.redis,
      ...overrides.redis,
    },
    minio: {
      ...base.minio,
      ...overrides.minio,
    },
  };
}

function developmentConfig(
  overrides: IsolationOverrides = {},
): EnvironmentIsolationInput {
  return mergeConfig(
    {
      appEnv: 'development',
      nodeEnv: 'development',
      allowProduction: false,
      host: '127.0.0.1',
      database: {
        host: '127.0.0.1',
        name: 'kode_platform',
      },
      redis: {
        host: '127.0.0.1',
      },
      minio: {
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'kode-dev',
      },
    },
    overrides,
  );
}

function stagingConfig(
  overrides: IsolationOverrides = {},
): EnvironmentIsolationInput {
  return mergeConfig(
    {
      appEnv: 'staging',
      nodeEnv: 'staging',
      allowProduction: false,
      host: '0.0.0.0',
      database: {
        host: 'staging-postgres',
        name: 'kode_platform_staging',
      },
      redis: {
        host: 'staging-redis',
      },
      minio: {
        endpoint: 'http://staging-minio:9000',
        bucket: 'kode-staging',
      },
    },
    overrides,
  );
}

function productionConfig(
  overrides: IsolationOverrides = {},
): EnvironmentIsolationInput {
  return mergeConfig(
    {
      appEnv: 'production',
      nodeEnv: 'production',
      allowProduction: true,
      host: '0.0.0.0',
      database: {
        host: 'production-postgres',
        name: 'kode_platform_production',
      },
      redis: {
        host: 'production-redis',
      },
      minio: {
        endpoint: 'http://production-minio:9000',
        bucket: 'kode-production',
      },
    },
    overrides,
  );
}

function assertRejects(config: EnvironmentIsolationInput, message: RegExp) {
  assert.throws(() => assertEnvironmentIsolation(config), message);
}

test('APP_ENV must be an explicit supported environment', () => {
  assert.equal(parseAppEnvironment('development'), 'development');
  assert.equal(parseAppEnvironment('staging'), 'staging');
  assert.equal(parseAppEnvironment('production'), 'production');
  assert.throws(() => parseAppEnvironment(undefined), /APP_ENV is required/);
  assert.throws(() => parseAppEnvironment('prod'), /APP_ENV must be one of/);
  assert.throws(() => parseAppEnvironment('dev'), /APP_ENV must be one of/);
});

test('hostname helpers treat loopback URLs as local', () => {
  assert.equal(hostnameOf('http://127.0.0.1:9000'), '127.0.0.1');
  assert.equal(isLoopbackHost('http://127.0.0.1:9000'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('production-postgres'), false);
});

test('valid development, staging, and production configs are accepted', () => {
  assert.doesNotThrow(() => assertEnvironmentIsolation(developmentConfig()));
  assert.doesNotThrow(() => assertEnvironmentIsolation(stagingConfig()));
  assert.doesNotThrow(() =>
    assertEnvironmentIsolation(productionConfig()),
  );
});

test('NODE_ENV must match APP_ENV', () => {
  assertRejects(
    developmentConfig({ nodeEnv: 'production' }),
    /NODE_ENV \(production\) must match APP_ENV \(development\)/,
  );
});

test('development cannot use remote infrastructure or production names', () => {
  assertRejects(
    developmentConfig({
      database: { host: 'production-postgres', name: 'kode_platform' },
    }),
    /loopback/,
  );
  assertRejects(
    developmentConfig({
      database: { host: '127.0.0.1', name: 'kode_platform_production' },
    }),
    /must not contain "production"/,
  );
  assertRejects(
    developmentConfig({
      database: { host: '127.0.0.1', name: 'kode_platform_staging' },
    }),
    /must not contain "staging"/,
  );
  assertRejects(
    developmentConfig({
      redis: { host: 'production-redis' },
    }),
    /loopback/,
  );
  assertRejects(
    developmentConfig({
      minio: {
        endpoint: 'http://production-minio:9000',
        bucket: 'kode-dev',
      },
    }),
    /loopback/,
  );
  assertRejects(
    developmentConfig({
      minio: {
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'kode-production',
      },
    }),
    /must not contain "production"/,
  );
  assertRejects(
    developmentConfig({ allowProduction: true }),
    /cannot set ALLOW_PRODUCTION=true/,
  );
  assertRejects(
    developmentConfig({ host: '0.0.0.0' }),
    /must bind to 127.0.0.1 or localhost/,
  );
});

test('staging cannot use production names, hosts, or the production allow flag', () => {
  assertRejects(
    stagingConfig({
      database: {
        host: 'production-postgres',
        name: 'kode_platform_staging',
      },
    }),
    /looks like a production host/,
  );
  assertRejects(
    stagingConfig({
      database: {
        host: 'staging-postgres',
        name: 'kode_platform_production',
      },
    }),
    /must contain "staging"/,
  );
  assertRejects(
    stagingConfig({
      minio: {
        endpoint: 'http://staging-minio:9000',
        bucket: 'kode-production',
      },
    }),
    /must contain "staging"/,
  );
  assertRejects(
    stagingConfig({ allowProduction: true }),
    /Staging cannot set ALLOW_PRODUCTION=true/,
  );
});

test('staging may use loopback when names still identify staging', () => {
  assert.doesNotThrow(() =>
    assertEnvironmentIsolation(
      stagingConfig({
        database: {
          host: '127.0.0.1',
          name: 'kode_platform_staging',
        },
        redis: { host: 'localhost' },
        minio: {
          endpoint: 'http://127.0.0.1:9000',
          bucket: 'kode-staging',
        },
      }),
    ),
  );
});

test('production requires an explicit allow flag and non-local production names', () => {
  assertRejects(
    productionConfig({ allowProduction: false }),
    /requires ALLOW_PRODUCTION=true/,
  );
  assertRejects(
    productionConfig({
      database: {
        host: '127.0.0.1',
        name: 'kode_platform_production',
      },
    }),
    /cannot be a loopback host/,
  );
  assertRejects(
    productionConfig({
      database: {
        host: 'production-postgres',
        name: 'kode_platform_staging',
      },
    }),
    /must contain "production"/,
  );
  assertRejects(
    productionConfig({
      minio: {
        endpoint: 'http://production-minio:9000',
        bucket: 'kode-dev',
      },
    }),
    /must contain "production"/,
  );
});
