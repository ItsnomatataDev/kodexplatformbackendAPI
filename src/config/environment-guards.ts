import {
  allowedEnvironments,
  type AppEnvironment,
} from './environments.js';

export type EnvironmentIsolationInput = {
  appEnv: AppEnvironment;
  nodeEnv: string;
  allowProduction: boolean;
  host: string;
  database: {
    host: string;
    name: string;
  };
  redis: {
    host: string;
  };
  minio: {
    endpoint: string;
    bucket: string;
  };
};

const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function hostnameOf(value: string): string {
  const trimmed = value.trim();

  try {
    if (trimmed.includes('://')) {
      return new URL(trimmed).hostname.toLowerCase();
    }
  } catch {
    throw new Error(`Invalid host or URL: ${value}`);
  }

  return trimmed.split('/')[0].split(':')[0].toLowerCase();
}

export function isLoopbackHost(value: string): boolean {
  return localHosts.has(hostnameOf(value));
}

function includesToken(value: string, token: string): boolean {
  return value.toLowerCase().includes(token);
}

function assertDatabaseNamePrefix(databaseName: string): void {
  if (!databaseName.startsWith('kode_')) {
    throw new Error('Database name must start with "kode_".');
  }
}

function assertNotProductionNamed(label: string, value: string): void {
  if (includesToken(value, 'production')) {
    throw new Error(`${label} must not contain "production".`);
  }
}

function assertNotStagingNamed(label: string, value: string): void {
  if (includesToken(value, 'staging')) {
    throw new Error(`${label} must not contain "staging".`);
  }
}

function assertContains(label: string, value: string, token: string): void {
  if (!includesToken(value, token)) {
    throw new Error(`${label} must contain "${token}".`);
  }
}

function assertLoopback(label: string, value: string): void {
  if (!isLoopbackHost(value)) {
    throw new Error(`${label} must be a loopback host in this environment.`);
  }
}

function assertNotLoopback(label: string, value: string): void {
  if (isLoopbackHost(value)) {
    throw new Error(`${label} cannot be a loopback host in this environment.`);
  }
}

function assertNoProductionHost(label: string, value: string): void {
  const hostname = hostnameOf(value);

  if (
    includesToken(hostname, 'production') ||
    hostname === 'prod' ||
    hostname.startsWith('prod-')
  ) {
    throw new Error(`${label} looks like a production host.`);
  }
}

function assertDevelopment(config: EnvironmentIsolationInput): void {
  if (config.allowProduction) {
    throw new Error(
      'Development cannot set ALLOW_PRODUCTION=true.',
    );
  }

  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    throw new Error(
      'Development API must bind to 127.0.0.1 or localhost.',
    );
  }

  assertLoopback('Development PostgreSQL host', config.database.host);
  assertLoopback('Development Redis host', config.redis.host);
  assertLoopback('Development MinIO endpoint', config.minio.endpoint);

  assertDatabaseNamePrefix(config.database.name);
  assertNotProductionNamed('Development database name', config.database.name);
  assertNotStagingNamed('Development database name', config.database.name);

  assertNotProductionNamed('Development MinIO bucket', config.minio.bucket);
  assertNotStagingNamed('Development MinIO bucket', config.minio.bucket);
}

function assertStaging(config: EnvironmentIsolationInput): void {
  if (config.allowProduction) {
    throw new Error('Staging cannot set ALLOW_PRODUCTION=true.');
  }

  assertDatabaseNamePrefix(config.database.name);
  assertContains('Staging database name', config.database.name, 'staging');
  assertNotProductionNamed('Staging database name', config.database.name);

  assertContains('Staging MinIO bucket', config.minio.bucket, 'staging');
  assertNotProductionNamed('Staging MinIO bucket', config.minio.bucket);

  assertNoProductionHost('Staging PostgreSQL host', config.database.host);
  assertNoProductionHost('Staging Redis host', config.redis.host);
  assertNoProductionHost('Staging MinIO endpoint', config.minio.endpoint);
}

function assertProduction(config: EnvironmentIsolationInput): void {
  if (!config.allowProduction) {
    throw new Error(
      'Production environment requires ALLOW_PRODUCTION=true.',
    );
  }

  assertDatabaseNamePrefix(config.database.name);
  assertContains(
    'Production database name',
    config.database.name,
    'production',
  );
  assertNotStagingNamed('Production database name', config.database.name);

  assertContains(
    'Production MinIO bucket',
    config.minio.bucket,
    'production',
  );
  assertNotStagingNamed('Production MinIO bucket', config.minio.bucket);

  if (config.minio.bucket.toLowerCase() === 'kode-dev') {
    throw new Error('Production MinIO bucket cannot be kode-dev.');
  }

  assertNotLoopback('Production PostgreSQL host', config.database.host);
  assertNotLoopback('Production Redis host', config.redis.host);
  assertNotLoopback('Production MinIO endpoint', config.minio.endpoint);
}

export function assertEnvironmentIsolation(
  config: EnvironmentIsolationInput,
): void {
  if (config.nodeEnv !== config.appEnv) {
    throw new Error(
      `NODE_ENV (${config.nodeEnv}) must match APP_ENV (${config.appEnv}).`,
    );
  }

  if (!allowedEnvironments.includes(config.appEnv)) {
    throw new Error(
      `APP_ENV must be one of: ${allowedEnvironments.join(', ')}`,
    );
  }

  switch (config.appEnv) {
    case 'development':
      assertDevelopment(config);
      return;
    case 'staging':
      assertStaging(config);
      return;
    case 'production':
      assertProduction(config);
      return;
  }
}
