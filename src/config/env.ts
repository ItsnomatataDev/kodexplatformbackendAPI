import 'dotenv/config';
import { parseAppEnvironment } from './environments.js';
import { assertEnvironmentIsolation } from './environment-guards.js';
import { parseCorsOrigins } from './cors-origins.js';

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function portFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }

  return value;
}

function authSecretFromEnv(appEnvironment: ReturnType<typeof parseAppEnvironment>): string {
  const secret = required('AUTH_TOKEN_SECRET');

  if (secret.length < 32) {
    throw new Error('AUTH_TOKEN_SECRET must be at least 32 characters.');
  }

  if (appEnvironment !== 'development' && secret.includes('dev-only')) {
    throw new Error(
      'Staging/production cannot use a development AUTH_TOKEN_SECRET.',
    );
  }

  if (appEnvironment === 'production' && /change_me/i.test(secret)) {
    throw new Error(
      'Production AUTH_TOKEN_SECRET cannot use the example placeholder.',
    );
  }

  return secret;
}

function ttlFromEnv(name: string, fallback: number): number {
  return durationFromEnv(name, fallback, 60, 3600);
}

function durationFromEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max} seconds.`,
    );
  }

  return value;
}

const appEnv = parseAppEnvironment(process.env.APP_ENV);
const nodeEnv = process.env.NODE_ENV ?? appEnv;
const allowProduction = process.env.ALLOW_PRODUCTION === 'true';

const databaseHost = required('DATABASE_HOST');
const databaseName = required('DATABASE_NAME');

const redisHost =
  appEnv === 'development'
    ? optional('REDIS_HOST', '127.0.0.1')
    : required('REDIS_HOST');

const minioEndpoint =
  appEnv === 'development'
    ? optional('MINIO_ENDPOINT', 'http://127.0.0.1:9000')
    : required('MINIO_ENDPOINT');

const minioBucket =
  appEnv === 'development'
    ? optional('MINIO_BUCKET', 'kode-dev')
    : required('MINIO_BUCKET');

const minioAccessKey =
  appEnv === 'development'
    ? optional('MINIO_ACCESS_KEY', '')
    : required('MINIO_ACCESS_KEY');

const minioSecretKey =
  appEnv === 'development'
    ? optional('MINIO_SECRET_KEY', '')
    : required('MINIO_SECRET_KEY');

const host =
  appEnv === 'development'
    ? optional('HOST', '127.0.0.1')
    : optional('HOST', '0.0.0.0');

assertEnvironmentIsolation({
  appEnv,
  nodeEnv,
  allowProduction,
  host,
  database: {
    host: databaseHost,
    name: databaseName,
  },
  redis: {
    host: redisHost,
  },
  minio: {
    endpoint: minioEndpoint,
    bucket: minioBucket,
  },
});

export const env = {
  appEnv,
  nodeEnv,
  allowProduction,

  port: portFromEnv('PORT', 3000),
  host,
  logLevel: optional('LOG_LEVEL', appEnv === 'development' ? 'debug' : 'info'),

  database: {
    host: databaseHost,
    port: portFromEnv('DATABASE_PORT', 5432),
    name: databaseName,
    user: required('DATABASE_USER'),
    password: required('DATABASE_PASSWORD'),
  },

  redis: {
    host: redisHost,
    port: portFromEnv('REDIS_PORT', 6379),
  },

  minio: {
    endpoint: minioEndpoint,
    accessKey: minioAccessKey,
    secretKey: minioSecretKey,
    bucket: minioBucket,
  },

  auth: {
    tokenSecret: authSecretFromEnv(appEnv),
    issuer: `kode-platform/${appEnv}`,
    audience: `kode-platform-api/${appEnv}`,
    accessTokenTtlSeconds: ttlFromEnv('AUTH_ACCESS_TOKEN_TTL_SECONDS', 900),
    refreshTokenTtlSeconds: durationFromEnv(
      'AUTH_REFRESH_TOKEN_TTL_SECONDS',
      60 * 60 * 24 * 7,
      3_600,
      60 * 60 * 24 * 30,
    ),
    passwordResetTtlSeconds: durationFromEnv(
      'AUTH_PASSWORD_RESET_TTL_SECONDS',
      1_800,
      300,
      3_600,
    ),
    cookieSecure: appEnv !== 'development',
  },

  cors: {
    allowedOrigins: parseCorsOrigins(appEnv, process.env.CORS_ALLOWED_ORIGINS),
  },
} as const;
