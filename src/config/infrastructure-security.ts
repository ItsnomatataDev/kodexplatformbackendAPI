import {
  hostnameOf,
  isLoopbackHost,
} from './environment-guards.js';
import type { AppEnvironment } from './environments.js';

const PLACEHOLDER_SECRET = /^(change_me|replace_with_runtime_secret)$/i;

const KNOWN_DEVELOPMENT_SECRETS = new Set([
  'kode_dev_password',
  'kode_dev_minio_password',
  'kode_dev',
  'dev-only-kode-platform-access-token-secret',
]);
const WILDCARD_PROXIES = new Set([
  '0.0.0.0',
  '0.0.0.0/0',
  '::',
  '::/0',
  '*',
]);

export type InfrastructureSecurityInput = {
  appEnv: AppEnvironment;
  database: {
    host: string;
    ssl: boolean;
    rejectUnauthorized: boolean;
    password: string;
  };
  redis: {
    host: string;
    tls: boolean;
    rejectUnauthorized: boolean;
    password: string;
  };
  minio: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
  };
  trustedProxyIps: readonly string[];
};

export function isKnownDevelopmentSecret(value: string | undefined): boolean {
  if (value == null) {
    return false;
  }

  return KNOWN_DEVELOPMENT_SECRETS.has(value.trim());
}

export function rejectKnownDevelopmentSecret(
  label: string,
  value: string | undefined,
): void {
  if (isKnownDevelopmentSecret(value)) {
    throw new Error(`${label} cannot use a known development secret.`);
  }
}

export function isPlaceholderSecret(value: string | undefined): boolean {
  if (value == null) {
    return true;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }

  if (PLACEHOLDER_SECRET.test(trimmed)) {
    return true;
  }

  return /change_me/i.test(trimmed);
}

export function minioEndpointUsesHttps(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`Invalid MinIO endpoint: ${endpoint}`);
  }

  return parsed.protocol === 'https:';
}

export function isLocalInfrastructure(input: {
  databaseHost: string;
  redisHost: string;
  minioEndpoint: string;
}): boolean {
  return (
    isLoopbackHost(input.databaseHost) &&
    isLoopbackHost(input.redisHost) &&
    isLoopbackHost(input.minioEndpoint)
  );
}

export function looksLikeDevelopmentHost(value: string): boolean {
  const hostname = hostnameOf(value);
  return (
    hostname.includes('development') ||
    hostname === 'dev' ||
    hostname.startsWith('dev-') ||
    hostname.includes('kode-dev')
  );
}

export function looksLikeStagingHost(value: string): boolean {
  const hostname = hostnameOf(value);
  return hostname.includes('staging');
}

export function hasWildcardTrustedProxy(ips: readonly string[]): boolean {
  return ips.some((entry) => WILDCARD_PROXIES.has(entry.trim().toLowerCase()));
}

export function redisRateLimitPrefix(appEnv: AppEnvironment): string {
  return `kode:${appEnv}:ratelimit:`;
}

export function redisRateLimitKey(appEnv: AppEnvironment, key: string): string {
  return `${redisRateLimitPrefix(appEnv)}${key}`;
}

function requireSecret(label: string, value: string): void {
  if (isPlaceholderSecret(value)) {
    throw new Error(`${label} must be set to a non-placeholder secret.`);
  }
}

function rejectDevelopmentSecrets(config: InfrastructureSecurityInput): void {
  rejectKnownDevelopmentSecret('DATABASE_PASSWORD', config.database.password);
  rejectKnownDevelopmentSecret('REDIS_PASSWORD', config.redis.password);
  rejectKnownDevelopmentSecret('MINIO_ACCESS_KEY', config.minio.accessKey);
  rejectKnownDevelopmentSecret('MINIO_SECRET_KEY', config.minio.secretKey);
}

function requireVerifiedTls(label: string, enabled: boolean, rejectUnauthorized: boolean): void {
  if (enabled && !rejectUnauthorized) {
    throw new Error(`${label} cannot disable certificate verification.`);
  }
}

function assertRemoteSecure(config: InfrastructureSecurityInput): void {
  if (!config.database.ssl) {
    throw new Error('This environment requires DATABASE_SSL=true for non-local PostgreSQL.');
  }

  if (!config.redis.tls) {
    throw new Error('This environment requires REDIS_TLS=true for non-local Redis.');
  }

  requireSecret('REDIS_PASSWORD', config.redis.password);

  if (!minioEndpointUsesHttps(config.minio.endpoint)) {
    throw new Error('This environment requires an https:// MinIO endpoint.');
  }

  requireSecret('MINIO_ACCESS_KEY', config.minio.accessKey);
  requireSecret('MINIO_SECRET_KEY', config.minio.secretKey);
}

function assertProduction(config: InfrastructureSecurityInput): void {
  if (isLoopbackHost(config.database.host)) {
    throw new Error('Production PostgreSQL host cannot be a loopback host.');
  }

  if (isLoopbackHost(config.redis.host)) {
    throw new Error('Production Redis host cannot be a loopback host.');
  }

  if (isLoopbackHost(config.minio.endpoint)) {
    throw new Error('Production MinIO endpoint cannot be a loopback host.');
  }

  if (looksLikeDevelopmentHost(config.redis.host) || looksLikeStagingHost(config.redis.host)) {
    throw new Error('Production Redis host cannot use development or staging naming.');
  }

  if (!config.database.ssl) {
    throw new Error('Production requires DATABASE_SSL=true.');
  }

  if (!config.redis.tls) {
    throw new Error('Production requires REDIS_TLS=true.');
  }

  requireSecret('DATABASE_PASSWORD', config.database.password);
  requireSecret('REDIS_PASSWORD', config.redis.password);
  requireSecret('MINIO_ACCESS_KEY', config.minio.accessKey);
  requireSecret('MINIO_SECRET_KEY', config.minio.secretKey);

  if (!minioEndpointUsesHttps(config.minio.endpoint)) {
    throw new Error('Production MinIO endpoint must use https://.');
  }

  if (config.trustedProxyIps.length === 0) {
    throw new Error('Production requires TRUSTED_PROXY_IPS for the reverse proxy.');
  }

  if (hasWildcardTrustedProxy(config.trustedProxyIps)) {
    throw new Error('TRUSTED_PROXY_IPS cannot trust every address.');
  }
}

function assertStaging(config: InfrastructureSecurityInput): void {
  if (hasWildcardTrustedProxy(config.trustedProxyIps)) {
    throw new Error('TRUSTED_PROXY_IPS cannot trust every address.');
  }

  const local = isLocalInfrastructure({
    databaseHost: config.database.host,
    redisHost: config.redis.host,
    minioEndpoint: config.minio.endpoint,
  });

  if (!local) {
    assertRemoteSecure(config);
  }
}

export function assertInfrastructureSecurity(config: InfrastructureSecurityInput): void {
  requireVerifiedTls('PostgreSQL TLS', config.database.ssl, config.database.rejectUnauthorized);
  requireVerifiedTls('Redis TLS', config.redis.tls, config.redis.rejectUnauthorized);

  switch (config.appEnv) {
    case 'development':
      if (hasWildcardTrustedProxy(config.trustedProxyIps)) {
        throw new Error('TRUSTED_PROXY_IPS cannot trust every address.');
      }
      return;
    case 'staging':
      assertStaging(config);
      rejectDevelopmentSecrets(config);
      return;
    case 'production':
      assertProduction(config);
      rejectDevelopmentSecrets(config);
      return;
  }
}
