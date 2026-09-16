import { isLoopbackHost } from './environment-guards.js';
import type { AppEnvironment } from './environments.js';

export function parseCorsOrigins(
  appEnv: AppEnvironment,
  raw: string | undefined,
): string[] {
  const origins = (raw ?? defaultCorsOrigins(appEnv))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS must include at least one origin.');
  }

  if (origins.includes('*')) {
    throw new Error('CORS_ALLOWED_ORIGINS cannot include "*".');
  }

  for (const origin of origins) {
    let parsed: URL;

    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }

    if (parsed.origin !== origin) {
      throw new Error(`CORS origin must be an exact origin: ${origin}`);
    }

    if (appEnv === 'development' && !isLoopbackHost(parsed.hostname)) {
      throw new Error(
        'Development CORS origins must use loopback hosts.',
      );
    }

    if (
      appEnv === 'staging' &&
      (parsed.hostname.includes('production') ||
        parsed.hostname.startsWith('prod-'))
    ) {
      throw new Error('Staging CORS origins cannot use production hosts.');
    }

    if (appEnv === 'production' && isLoopbackHost(parsed.hostname)) {
      throw new Error('Production CORS origins cannot use loopback hosts.');
    }
  }

  return origins;
}

function defaultCorsOrigins(appEnv: AppEnvironment): string {
  if (appEnv === 'development') {
    return [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://localhost:3000',
    ].join(',');
  }

  throw new Error(
    'CORS_ALLOWED_ORIGINS is required in staging and production.',
  );
}
