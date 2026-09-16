import assert from 'node:assert/strict';
import { test } from 'node:test';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { logRedactCensor, logRedactPaths } from '../src/config/redaction.js';
import { parseCorsOrigins } from '../src/config/cors-origins.js';

test('logger redaction paths hide credentials and tokens', async () => {
  const chunks: string[] = [];
  const logger = pino(
    {
      redact: {
        paths: [...logRedactPaths],
        censor: logRedactCensor,
      },
    },
    {
      write(chunk) {
        chunks.push(chunk);
      },
    },
  );

  logger.info(
    {
      password: 'super-secret-password',
      refreshToken: 'refresh-secret',
      resetToken: 'reset-secret',
      authorization: 'Bearer access-secret',
      cookie: 'kode_refresh=cookie-secret',
    },
    'auth probe',
  );

  const output = chunks.join('');
  assert.match(output, /\[Redacted\]/);
  assert.doesNotMatch(output, /super-secret-password/);
  assert.doesNotMatch(output, /refresh-secret/);
  assert.doesNotMatch(output, /reset-secret/);
  assert.doesNotMatch(output, /access-secret/);
  assert.doesNotMatch(output, /cookie-secret/);
});

test('CORS origins are environment-specific and cannot be wildcarded', () => {
  assert.throws(
    () => parseCorsOrigins('development', '*'),
    /cannot include "\*"/,
  );
  assert.throws(
    () => parseCorsOrigins('development', 'https://app.example.com'),
    /loopback/,
  );
  assert.throws(
    () => parseCorsOrigins('staging', 'https://production.example.com'),
    /production/,
  );
  assert.throws(
    () => parseCorsOrigins('production', 'http://127.0.0.1:5173'),
    /loopback/,
  );
  assert.deepEqual(
    parseCorsOrigins('staging', 'https://staging.kode.example'),
    ['https://staging.kode.example'],
  );
});

test('health remains unauthenticated and receives security headers', async () => {
  const app = createApp({
    auth: {
      verifier: {
        async verify() {
          throw new Error('auth should not run for health');
        },
      },
      resolveAuthContext: async () => {
        throw new Error('auth should not run for health');
      },
    },
  });

  const response = await app.request('/health/live');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
