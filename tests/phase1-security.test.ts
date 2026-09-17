import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import { LoginService } from '../src/auth/login.js';
import { MemoryAuthStore } from '../src/auth/memory-store.js';
import { MemoryRateLimiter, type RateLimiter } from '../src/auth/rate-limit.js';
import { PasswordService } from '../src/auth/password-service.js';
import { hashPassword } from '../src/auth/passwords.js';
import { SessionService } from '../src/auth/sessions.js';
import type { AuthContext } from '../src/authorization/types.js';
import { decodeStrictBase64 } from '../src/http/base64.js';
import { resolveClientIp } from '../src/http/client-ip.js';
import { AppError, PayloadTooLargeError, ServiceUnavailableError } from '../src/http/errors.js';
import { FIELD_LIMITS } from '../src/http/limits.js';
import { MemoryBoardStore } from '../src/work/memory-store.js';
import {
  authContext,
  bearer,
  createBoard,
  createCard,
  createColumn,
  createWorkApp,
  json,
  orgBContext,
  sessionAuth,
  tamperJwt,
  tokenService,
  userA,
  userB,
} from './work-harness.js';

const password = 'correct-horse-battery';
const corsOrigins = ['http://127.0.0.1:5173'];
const secret = 'test-only-access-token-secret-value!!';

function trackingLimiter(inner: RateLimiter) {
  const keys: string[] = [];
  const limiter: RateLimiter & { keys: string[] } = {
    keys,
    async consume(key, limit, windowSeconds) {
      keys.push(key);
      return inner.consume(key, limit, windowSeconds);
    },
  };
  return limiter;
}

function unavailableLimiter(): RateLimiter {
  return {
    async consume() {
      throw new ServiceUnavailableError(
        'RATE_LIMIT_UNAVAILABLE',
        'Rate limiting is temporarily unavailable.',
      );
    },
  };
}

function envForIp(ip: string) {
  return {
    incoming: {
      socket: {
        remoteAddress: ip,
      },
    },
  };
}

async function requestJson(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
  ip = '127.0.0.1',
) {
  const response = await app.request(path, init, envForIp(ip));
  return { response, body: await json(response) };
}

async function createAuthHarness(options: { rateLimiter?: RateLimiter } = {}) {
  const store = new MemoryAuthStore();
  const passwordHash = await hashPassword(password);
  store.seedUser({
    userId: userA,
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    isActive: true,
    accountStatus: 'active',
    deletedAt: null,
    passwordHash,
  });

  const accessTokens = new AccessTokenService({
    secret,
    issuer: 'kode-platform/test',
    audience: 'kode-platform-api/test',
    ttlSeconds: 900,
    clockToleranceSeconds: 0,
  });

  const resolve = async (userId: string): Promise<AuthContext> => {
    if (userId !== userA) {
      throw new Error('unexpected user');
    }
    return authContext({
      membership: {
        roleKey: 'member',
        isAdminRole: false,
      },
    });
  };

  const sessions = new SessionService({
    store,
    tokenSecret: secret,
    accessTokens,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3_600,
    resolveAuthContext: resolve,
  });

  const auth = {
    verifier: accessTokens,
    resolveAuthContext: resolve,
    requireActiveSession: (sessionId: string, userId: string) =>
      sessions.requireActiveSession(sessionId, userId),
  };

  const app = createApp({
    auth,
    me: {
      loadPublicProfile: async () => null,
    },
    authLifecycle: {
      auth,
      login: new LoginService({ store, sessions }),
      sessions,
      passwords: new PasswordService({
        store,
        sessions,
        tokenSecret: secret,
        passwordResetTtlSeconds: 1_800,
        sendPasswordResetEmail: async () => undefined,
      }),
      rateLimiter: options.rateLimiter ?? new MemoryRateLimiter(['test']),
      cookies: {
        secure: false,
        refreshMaxAgeSeconds: 3_600,
      },
    },
    corsOrigins,
  });

  return { app, store, sessions, accessTokens };
}

async function login(
  app: ReturnType<typeof createApp>,
  ip = '127.0.0.1',
  headers: Record<string, string> = {},
) {
  return requestJson(
    app,
    '/auth/login',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ email: 'user@example.com', password }),
    },
    ip,
  );
}

const tightPolicies = {
  mutation: { limit: 2, windowSeconds: 60 },
  mutationOrg: { limit: 100, windowSeconds: 60 },
  mutationIp: { limit: 100, windowSeconds: 60 },
  attachment: { limit: 1, windowSeconds: 60 },
  attachmentOrg: { limit: 100, windowSeconds: 60 },
  attachmentIp: { limit: 100, windowSeconds: 60 },
};

function errorCode(error: unknown) {
  assert.equal(error instanceof AppError, true);
  return (error as AppError).code;
}

test('PB-01 request under the global body limit is accepted', async () => {
  const { app } = await createAuthHarness();
  const { response, body } = await requestJson(app, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password }),
  });

  assert.equal(response.status, 200);
  assert.notEqual(body.error?.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(typeof body.access_token, 'string');
});

test('PB-01 request above the global body limit returns 413', async () => {
  const app = createApp({
    limits: { maxRequestBodyBytes: 64, maxAttachmentBytes: 16 },
    auth: {
      verifier: tokenService,
      resolveAuthContext: async () => authContext(),
      requireActiveSession: async () => undefined,
    },
    me: { loadPublicProfile: async () => null },
  });

  const { response, body } = await requestJson(app, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(80),
  });

  assert.equal(response.status, 413);
  assert.equal(body.error?.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(body.error?.message.includes('stack'), false);
});

test('PB-01 empty, invalid, and malformed Base64 is rejected before allocation', () => {
  assert.equal(errorCode(catchError(() => decodeStrictBase64('', 'contentBase64', 8))), 'VALIDATION_ERROR');
  assert.equal(errorCode(catchError(() => decodeStrictBase64('****', 'contentBase64', 8))), 'VALIDATION_ERROR');
  assert.equal(errorCode(catchError(() => decodeStrictBase64('YQ=', 'contentBase64', 8))), 'VALIDATION_ERROR');
  assert.equal(errorCode(catchError(() => decodeStrictBase64('aGVsbG8===', 'contentBase64', 8))), 'VALIDATION_ERROR');
  assert.equal(errorCode(catchError(() => decodeStrictBase64('aGVsbG8', 'contentBase64', 8))), 'VALIDATION_ERROR');

  const oversized = catchError(() => decodeStrictBase64('AAAAAAAAAAAAAA==', 'contentBase64', 8));
  assert.equal(oversized instanceof PayloadTooLargeError, true);
});

test('PB-01 valid small Base64 still decodes', () => {
  const decoded = decodeStrictBase64(Buffer.from('hello').toString('base64'), 'contentBase64', 16);
  assert.equal(decoded.toString(), 'hello');
});

test('PB-01 attachment, title, comment, and metadata limits are enforced', async () => {
  const app = createWorkApp(new MemoryBoardStore(), undefined, undefined, {
    limits: { maxRequestBodyBytes: 32_768, maxAttachmentBytes: 8 },
  });
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);

  const longTitle = await requestJson(app, `/api/boards/${boardId}/cards`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 't'.repeat(FIELD_LIMITS.cardTitle + 1), columnId }),
  });
  assert.equal(longTitle.response.status, 400);
  assert.equal(longTitle.body.error?.code, 'VALIDATION_ERROR');

  const longComment = await requestJson(app, `/api/cards/${card.id}/comments`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: 'c'.repeat(FIELD_LIMITS.commentBody + 1) }),
  });
  assert.equal(longComment.response.status, 400);
  assert.equal(longComment.body.error?.code, 'VALIDATION_ERROR');

  const hugeMetadata = await requestJson(app, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Meta',
      metadata: { blob: 'x'.repeat(FIELD_LIMITS.metadataMaxBytes) },
    }),
  });
  assert.equal(hugeMetadata.response.status, 413);
  assert.equal(hugeMetadata.body.error?.code, 'PAYLOAD_TOO_LARGE');

  const emptyAttachment = await requestJson(app, `/api/cards/${card.id}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: 'empty.bin',
      contentType: 'application/octet-stream',
      contentBase64: '',
    }),
  });
  assert.equal(emptyAttachment.response.status, 400);
  assert.equal(emptyAttachment.body.error?.code, 'VALIDATION_ERROR');

  const invalidAttachment = await requestJson(app, `/api/cards/${card.id}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: 'bad.bin',
      contentType: 'application/octet-stream',
      contentBase64: '$$$$',
    }),
  });
  assert.equal(invalidAttachment.response.status, 400);

  const tooLargeAttachment = await requestJson(app, `/api/cards/${card.id}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: 'big.bin',
      contentType: 'application/octet-stream',
      contentBase64: Buffer.from('123456789').toString('base64'),
    }),
  });
  assert.equal(tooLargeAttachment.response.status, 413);
  assert.equal(tooLargeAttachment.body.error?.code, 'PAYLOAD_TOO_LARGE');

  const okAttachment = await requestJson(app, `/api/cards/${card.id}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: 'ok.bin',
      contentType: 'application/octet-stream',
      contentBase64: Buffer.from('hello').toString('base64'),
    }),
  });
  assert.equal(okAttachment.response.status, 201);
  assert.equal(okAttachment.body.attachment.originalFilename, 'ok.bin');
  assert.equal(okAttachment.body.attachment.sizeBytes, 5);
});

test('PB-04 valid session JWT can call /api/me and health stays public', async () => {
  const { app } = await createAuthHarness();
  const issued = await login(app);
  assert.equal(issued.response.status, 200);

  const me = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${issued.body.access_token}` },
  });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.user?.id, userA);

  const live = await requestJson(app, '/health/live');
  assert.equal(live.response.status, 200);
  const ready = await requestJson(app, '/health');
  assert.ok(ready.response.status === 200 || ready.response.status === 503);
});

test('PB-04 logout, logout-all, and password change revoke access JWTs immediately', async () => {
  const { app } = await createAuthHarness();
  const first = await login(app);
  const second = await login(app);

  const afterLogout = await requestJson(app, '/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${first.body.access_token}` },
  });
  assert.equal(afterLogout.response.status, 200);

  const firstMe = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${first.body.access_token}` },
  });
  assert.equal(firstMe.response.status, 401);
  assert.equal(firstMe.body.error?.code, 'SESSION_REVOKED');

  const secondStillWorks = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${second.body.access_token}` },
  });
  assert.equal(secondStillWorks.response.status, 200);

  const logoutAll = await requestJson(app, '/auth/logout-all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${second.body.access_token}` },
  });
  assert.equal(logoutAll.response.status, 200);

  const secondMe = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${second.body.access_token}` },
  });
  assert.equal(secondMe.response.status, 401);
  assert.equal(secondMe.body.error?.code, 'SESSION_REVOKED');

  const beforeChange = await login(app);
  const changed = await requestJson(app, '/auth/password/change', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${beforeChange.body.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      current_password: password,
      new_password: 'brand-new-password-value',
    }),
  });
  assert.equal(changed.response.status, 200);

  const oldMe = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${beforeChange.body.access_token}` },
  });
  assert.equal(oldMe.response.status, 401);
  assert.equal(oldMe.body.error?.code, 'SESSION_REVOKED');

  const newMe = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${changed.body.access_token}` },
  });
  assert.equal(newMe.response.status, 200);
});

test('PB-04 revoked, expired, tampered, and missing-sid tokens are rejected', async () => {
  const app = createWorkApp(new MemoryBoardStore());
  const issued = await sessionAuth.issueBearer(userA);

  const ok = await requestJson(app, '/api/me', {
    headers: { Authorization: issued.authorization },
  });
  assert.equal(ok.response.status, 200);

  sessionAuth.revoke(issued.sessionId);
  const revoked = await requestJson(app, '/api/me', {
    headers: { Authorization: issued.authorization },
  });
  assert.equal(revoked.response.status, 401);
  assert.equal(revoked.body.error?.code, 'SESSION_REVOKED');

  const expired = await tokenService.issue(userA, {
    sessionId: issued.sessionId,
    expiresAt: new Date(Date.now() - 30_000),
  });
  const expiredResponse = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${expired}` },
  });
  assert.equal(expiredResponse.response.status, 401);
  assert.equal(expiredResponse.body.error?.code, 'EXPIRED_CREDENTIAL');

  const fresh = await sessionAuth.issueBearer(userA);
  const tampered = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${tamperJwt(fresh.token)}` },
  });
  assert.equal(tampered.response.status, 401);
  assert.equal(tampered.body.error?.code, 'INVALID_CREDENTIAL');

  const missingSid = await tokenService.issue(userA);
  const missing = await requestJson(app, '/api/me', {
    headers: { Authorization: `Bearer ${missingSid}` },
  });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.error?.code, 'SESSION_REQUIRED');
});

test('PB-09 direct clients cannot spoof X-Forwarded-For or X-Real-IP', async () => {
  assert.equal(
    resolveClientIp({
      remoteAddress: '127.0.0.1',
      forwardedFor: '8.8.8.8',
      realIp: '1.1.1.1',
      trustedProxyIps: [],
    }),
    '127.0.0.1',
  );
  assert.equal(
    resolveClientIp({
      remoteAddress: '::1',
      forwardedFor: '2001:db8::2',
      trustedProxyIps: [],
    }),
    '::1',
  );
  assert.equal(
    resolveClientIp({
      remoteAddress: '203.0.113.10',
      forwardedFor: '198.51.100.1, 10.0.0.1',
      trustedProxyIps: [],
    }),
    '203.0.113.10',
  );
  assert.equal(
    resolveClientIp({
      remoteAddress: '10.0.0.1',
      forwardedFor: '198.51.100.1, 10.0.0.1',
      trustedProxyIps: ['10.0.0.1'],
    }),
    '198.51.100.1',
  );
  assert.equal(
    resolveClientIp({
      remoteAddress: '10.0.0.1',
      realIp: '198.51.100.9',
      trustedProxyIps: ['10.0.0.1'],
    }),
    '198.51.100.9',
  );
  assert.equal(
    resolveClientIp({
      remoteAddress: '203.0.113.10',
      realIp: '198.51.100.9',
      trustedProxyIps: ['10.0.0.1'],
    }),
    '203.0.113.10',
  );
  assert.equal(
    resolveClientIp({
      remoteAddress: '::ffff:192.0.2.1',
      trustedProxyIps: [],
    }),
    '192.0.2.1',
  );
  assert.equal(
    resolveClientIp({
      remoteAddress: '2001:db8::1',
      forwardedFor: '2001:db8:cafe::1',
      trustedProxyIps: ['2001:db8::1'],
    }),
    '2001:db8:cafe::1',
  );

  const limiter = trackingLimiter(new MemoryRateLimiter(['test']));
  const { app } = await createAuthHarness({ rateLimiter: limiter });
  await login(app, '203.0.113.10', {
    'X-Forwarded-For': '198.51.100.1',
    'X-Real-IP': '192.0.2.1',
  });

  assert.equal(limiter.keys.includes('login:ip:203.0.113.10'), true);
  assert.equal(limiter.keys.includes('login:ip:198.51.100.1'), false);
  assert.equal(limiter.keys.includes('login:ip:192.0.2.1'), false);
});

test('PB-09 trusted proxies use the right-most untrusted X-Forwarded-For hop', async () => {
  const limiter = trackingLimiter(new MemoryRateLimiter(['test']));
  const app = createApp({
    trustedProxyIps: ['10.0.0.1'],
    authLifecycle: {
      auth: {
        verifier: tokenService,
        resolveAuthContext: async () => authContext(),
        requireActiveSession: async () => undefined,
      },
      login: {
        async login() {
          return {
            accessToken: 'x',
            refreshToken: 'y',
            expiresIn: 900,
            sessionId: '11111111-1111-1111-1111-111111111111',
            context: authContext(),
          };
        },
      } as never,
      sessions: {} as never,
      passwords: {} as never,
      rateLimiter: limiter,
      cookies: { secure: false, refreshMaxAgeSeconds: 60 },
    },
    corsOrigins,
  });

  await requestJson(
    app,
    '/auth/login',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.1, 10.0.0.1',
      },
      body: JSON.stringify({ email: 'user@example.com', password: 'x' }),
    },
    '10.0.0.1',
  );

  assert.equal(limiter.keys.includes('login:ip:198.51.100.1'), true);
  assert.equal(limiter.keys.includes('login:ip:10.0.0.1'), false);
});

test('PB-09 untrusted forwarded headers cannot bypass the login IP limiter', async () => {
  const limiter = new MemoryRateLimiter(['test']);
  for (let index = 0; index < 10; index += 1) {
    await limiter.consume('login:ip:203.0.113.10', 10, 900);
  }
  const { app } = await createAuthHarness({ rateLimiter: limiter });
  const blocked = await login(app, '203.0.113.10', {
    'X-Forwarded-For': '198.51.100.1',
  });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.body.error?.code, 'RATE_LIMITED');
  assert.equal(blocked.response.headers.get('Retry-After') != null, true);
});

test('PB-11 Work mutations and attachments are rate limited after authorization', async () => {
  const limiter = trackingLimiter(new MemoryRateLimiter(['test']));
  const app = createWorkApp(new MemoryBoardStore(), undefined, undefined, {
    rateLimiter: limiter,
    rateLimitPolicies: tightPolicies,
  });
  const authorization = await bearer(userA);

  const first = await requestJson(app, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'One' }),
  });
  const second = await requestJson(app, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Two' }),
  });
  const third = await requestJson(app, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Three' }),
  });

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.equal(third.response.status, 429);
  assert.equal(third.body.error?.code, 'RATE_LIMITED');
  assert.equal(third.response.headers.get('Retry-After') != null, true);
  assert.equal(
    limiter.keys.includes(`work:mutate:user:${userA}`),
    true,
  );
  assert.equal(
    limiter.keys.some((key) => key.startsWith('work:mutate:org:')),
    true,
  );
  assert.equal(
    limiter.keys.includes('work:mutate:ip:127.0.0.1'),
    true,
  );

  const unauthorizedApp = createWorkApp(
    new MemoryBoardStore(),
    async () =>
      authContext({
        membership: {
          isAdminRole: false,
          roleKey: 'member',
          permissions: {},
        },
      }),
    undefined,
    {
      rateLimiter: {
        async consume() {
          return { allowed: false, retryAfterSeconds: 30 };
        },
      },
    },
  );
  const denied = await requestJson(unauthorizedApp, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: await bearer(userA),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Nope' }),
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error?.code, 'INSUFFICIENT_PERMISSION');
});

test('PB-11 different users and organizations do not share mutation buckets', async () => {
  const app = createWorkApp(new MemoryBoardStore(), async (userId) => {
    if (userId === userB) {
      return orgBContext();
    }
    return authContext();
  }, undefined, {
    rateLimitPolicies: {
      ...tightPolicies,
      mutation: { limit: 1, windowSeconds: 60 },
    },
  });

  const firstA = await requestJson(app, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: await bearer(userA),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'A1' }),
  });
  const secondA = await requestJson(app, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: await bearer(userA),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'A2' }),
  });
  const firstB = await requestJson(app, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: await bearer(userB),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'B1' }),
  });

  assert.equal(firstA.response.status, 201);
  assert.equal(secondA.response.status, 429);
  assert.equal(firstB.response.status, 201);
});

test('PB-11 attachment limiter is stricter and IP dimension uses trusted-proxy IP', async () => {
  const limiter = trackingLimiter(new MemoryRateLimiter(['test']));
  const app = createWorkApp(new MemoryBoardStore(), undefined, undefined, {
    rateLimiter: limiter,
    rateLimitPolicies: {
      ...tightPolicies,
      mutation: { limit: 100, windowSeconds: 60 },
    },
    trustedProxyIps: ['10.0.0.1'],
  });
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);

  const first = await requestJson(
    app,
    `/api/cards/${card.id}/attachments`,
    {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.7',
      },
      body: JSON.stringify({
        filename: 'one.bin',
        contentType: 'application/octet-stream',
        contentBase64: Buffer.from('hello').toString('base64'),
      }),
    },
    '10.0.0.1',
  );
  const second = await requestJson(
    app,
    `/api/cards/${card.id}/attachments`,
    {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.7',
      },
      body: JSON.stringify({
        filename: 'two.bin',
        contentType: 'application/octet-stream',
        contentBase64: Buffer.from('hello').toString('base64'),
      }),
    },
    '10.0.0.1',
  );

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 429);
  assert.equal(limiter.keys.includes(`work:attach:user:${userA}`), true);
  assert.equal(limiter.keys.includes('work:attach:ip:198.51.100.7'), true);
  assert.equal(limiter.keys.includes('work:attach:ip:10.0.0.1'), false);
});

test('PB-11 Redis-style limiter failures fail closed and health stays unlimited', async () => {
  const app = createWorkApp(new MemoryBoardStore(), undefined, undefined, {
    rateLimiter: unavailableLimiter(),
  });
  const failed = await requestJson(app, '/api/boards', {
    method: 'POST',
    headers: {
      Authorization: await bearer(userA),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Nope' }),
  });
  assert.equal(failed.response.status, 503);
  assert.equal(failed.body.error?.code, 'RATE_LIMIT_UNAVAILABLE');

  const live = await requestJson(app, '/health/live');
  assert.equal(live.response.status, 200);
  const ready = await requestJson(app, '/health/ready');
  assert.ok(ready.response.status === 200 || ready.response.status === 503);
});

function catchError(run: () => unknown) {
  try {
    run();
    throw new Error('expected an error');
  } catch (error) {
    return error;
  }
}
