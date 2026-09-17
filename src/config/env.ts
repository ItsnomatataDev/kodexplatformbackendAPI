import 'dotenv/config';
import { parseAppEnvironment } from './environments.js';
import { assertEnvironmentIsolation } from './environment-guards.js';
import { parseCorsOrigins } from './cors-origins.js';
import { parseTrustedProxyIps } from '../http/client-ip.js';
import {
  minRequestBodyBytesForAttachment,
  type WorkRateLimitPolicies,
} from '../http/limits.js';
import {
  assertInfrastructureSecurity,
  isLocalInfrastructure,
  rejectKnownDevelopmentSecret,
} from './infrastructure-security.js';
import {
  assertEmailDeliveryConfigured,
  parseEmailDeliveryConfig,
} from './email-delivery.js';
import { readTlsCaFile } from './tls.js';

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

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];

  if (value == null || value === '') {
    return fallback;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be true or false.`);
}

function requiredEnabled(name: string): true {
  if (process.env[name] !== 'true') {
    throw new Error(`${name}=true is required in this environment.`);
  }

  return true;
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

  if (appEnvironment !== 'development') {
    rejectKnownDevelopmentSecret('AUTH_TOKEN_SECRET', secret);

    if (secret.includes('dev-only')) {
      throw new Error(
        'Staging/production cannot use a development AUTH_TOKEN_SECRET.',
      );
    }
  }

  if (appEnvironment === 'production' && /change_me|replace_with_runtime_secret/i.test(secret)) {
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

function bytesFromEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} bytes.`);
  }

  return value;
}

function countFromEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return value;
}

const appEnv = parseAppEnvironment(process.env.APP_ENV);
const nodeEnv = process.env.NODE_ENV ?? appEnv;
const allowProduction = process.env.ALLOW_PRODUCTION === 'true';

const databaseHost = required('DATABASE_HOST');
const databaseName = required('DATABASE_NAME');
const databasePassword = required('DATABASE_PASSWORD');

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

const trustedProxyIps = parseTrustedProxyIps(process.env.TRUSTED_PROXY_IPS);

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

const localInfrastructure = isLocalInfrastructure({
  databaseHost,
  redisHost,
  minioEndpoint,
});

const remoteTlsDefault = appEnv === 'staging' && !localInfrastructure;
const databaseSsl =
  appEnv === 'production' ? requiredEnabled('DATABASE_SSL') : booleanFromEnv('DATABASE_SSL', remoteTlsDefault);
const redisTls =
  appEnv === 'production' ? requiredEnabled('REDIS_TLS') : booleanFromEnv('REDIS_TLS', remoteTlsDefault);
const redisPassword = optional('REDIS_PASSWORD', '');
const redisUsername = optional('REDIS_USERNAME', '');

assertInfrastructureSecurity({
  appEnv,
  database: {
    host: databaseHost,
    ssl: databaseSsl,
    rejectUnauthorized: true,
    password: databasePassword,
  },
  redis: {
    host: redisHost,
    tls: redisTls,
    rejectUnauthorized: true,
    password: redisPassword,
  },
  minio: {
    endpoint: minioEndpoint,
    accessKey: minioAccessKey,
    secretKey: minioSecretKey,
  },
  trustedProxyIps,
});

const email = parseEmailDeliveryConfig(process.env);
assertEmailDeliveryConfigured({
  appEnv,
  localInfrastructure,
  email,
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
    password: databasePassword,
    ssl: databaseSsl,
    rejectUnauthorized: true as const,
    ca: readTlsCaFile(process.env.DATABASE_SSL_CA_FILE, 'DATABASE_SSL_CA_FILE'),
  },

  redis: {
    host: redisHost,
    port: portFromEnv('REDIS_PORT', 6379),
    username: redisUsername || undefined,
    password: redisPassword || undefined,
    tls: redisTls,
    rejectUnauthorized: true as const,
    ca: readTlsCaFile(process.env.REDIS_TLS_CA_FILE, 'REDIS_TLS_CA_FILE'),
  },

  minio: {
    endpoint: minioEndpoint,
    accessKey: minioAccessKey,
    secretKey: minioSecretKey,
    bucket: minioBucket,
    ca: readTlsCaFile(process.env.MINIO_TLS_CA_FILE, 'MINIO_TLS_CA_FILE'),
  },

  email,

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

  trustedProxyIps,

  limits: (() => {
    const maxAttachmentBytes = bytesFromEnv(
      'MAX_ATTACHMENT_BYTES',
      10 * 1024 * 1024,
      1,
      50 * 1024 * 1024,
    );
    const minRequestBodyBytes = minRequestBodyBytesForAttachment(maxAttachmentBytes);
    const maxRequestBodyBytes = bytesFromEnv(
      'MAX_REQUEST_BODY_BYTES',
      Math.max(16 * 1024 * 1024, minRequestBodyBytes),
      minRequestBodyBytes,
      64 * 1024 * 1024,
    );

    return {
      maxAttachmentBytes,
      maxRequestBodyBytes,
    };
  })(),

  rateLimits: {
    mutation: {
      limit: countFromEnv('WORK_MUTATION_RATE_LIMIT', 60, 1, 10_000),
      windowSeconds: durationFromEnv('WORK_MUTATION_RATE_WINDOW_SECONDS', 60, 1, 3_600),
    },
    mutationOrg: {
      limit: countFromEnv('WORK_ORG_MUTATION_RATE_LIMIT', 180, 1, 50_000),
      windowSeconds: durationFromEnv('WORK_MUTATION_RATE_WINDOW_SECONDS', 60, 1, 3_600),
    },
    mutationIp: {
      limit: countFromEnv('WORK_IP_MUTATION_RATE_LIMIT', 120, 1, 20_000),
      windowSeconds: durationFromEnv('WORK_MUTATION_RATE_WINDOW_SECONDS', 60, 1, 3_600),
    },
    attachment: {
      limit: countFromEnv('WORK_ATTACHMENT_RATE_LIMIT', 10, 1, 1_000),
      windowSeconds: durationFromEnv('WORK_ATTACHMENT_RATE_WINDOW_SECONDS', 60, 1, 3_600),
    },
    attachmentOrg: {
      limit: countFromEnv('WORK_ORG_ATTACHMENT_RATE_LIMIT', 30, 1, 5_000),
      windowSeconds: durationFromEnv('WORK_ATTACHMENT_RATE_WINDOW_SECONDS', 60, 1, 3_600),
    },
    attachmentIp: {
      limit: countFromEnv('WORK_IP_ATTACHMENT_RATE_LIMIT', 20, 1, 2_000),
      windowSeconds: durationFromEnv('WORK_ATTACHMENT_RATE_WINDOW_SECONDS', 60, 1, 3_600),
    },
  } satisfies WorkRateLimitPolicies,
} as const;
