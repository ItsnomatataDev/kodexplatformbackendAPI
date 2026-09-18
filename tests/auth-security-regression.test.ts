import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import { CSRF_COOKIE, REFRESH_COOKIE } from '../src/auth/cookies.js';
import { CapturingEmailSender } from '../src/auth/email.js';
import { LoginService } from '../src/auth/login.js';
import { MemoryAuthStore } from '../src/auth/memory-store.js';
import { PasswordService } from '../src/auth/password-service.js';
import { hashPassword } from '../src/auth/passwords.js';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import { SessionService } from '../src/auth/sessions.js';
import type { AuthContext } from '../src/authorization/types.js';
import { UnauthorizedError } from '../src/http/errors.js';

const userA = '11111111-1111-1111-1111-111111111111';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const secret = 'test-only-access-token-secret-value!!';
const password = 'correct-horse-battery';
const wrongPassword = 'wrong-password-value';
const corsOrigins = ['http://127.0.0.1:5173'];
const genericAuthFailure = 'Authentication failed.';
const genericAuthRequired = 'Authentication is required.';

type AuthBody = {
  access_token?: string;
  refresh_token?: string;
  session_id?: string;
  token_type?: string;
  user?: { id: string };
  organization?: { id: string };
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    [key: string]: unknown;
  };
  revoked?: boolean | number;
};

function authContext(): AuthContext {
  return {
    actor: {
      userId: userA,
      email: 'user@example.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId: orgA,
      officeId: null,
      roleId: 'role-1',
      roleKey: 'member',
      status: 'active',
      isAdminRole: false,
      isManagerRole: false,
      permissions: {},
    },
    organization: {
      organizationId: orgA,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

async function json(response: Response): Promise<AuthBody> {
  return response.json() as Promise<AuthBody>;
}

async function createHarness() {
  const store = new MemoryAuthStore();
  store.seedUser({
    userId: userA,
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    isActive: true,
    accountStatus: 'active',
    deletedAt: null,
    passwordHash: await hashPassword(password),
  });

  const accessTokens = new AccessTokenService({
    secret,
    issuer: 'kode-platform/test',
    audience: 'kode-platform-api/test',
    ttlSeconds: 900,
    clockToleranceSeconds: 0,
  });

  const resolve = async (userId: string) => {
    if (userId !== userA) {
      throw new UnauthorizedError(
        'IDENTITY_NOT_FOUND',
        'The authenticated identity is no longer valid.',
      );
    }

    return authContext();
  };

  const sessions = new SessionService({
    store,
    tokenSecret: secret,
    accessTokens,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3_600,
    resolveAuthContext: resolve,
  });

  const email = new CapturingEmailSender();
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
        sendPasswordResetEmail: (message) => email.sendPasswordReset(message),
      }),
      rateLimiter: new MemoryRateLimiter(['test']),
      cookies: {
        secure: false,
        refreshMaxAgeSeconds: 3_600,
      },
    },
    corsOrigins,
  });

  return { app, store };
}

async function login(
  app: ReturnType<typeof createApp>,
  email = 'user@example.com',
  loginPassword = password,
) {
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: loginPassword }),
  });

  return { response, body: await json(response) };
}

function setCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const header = response.headers.get('set-cookie');
  return header ? [header] : [];
}

function cookieCleared(headers: string[], name: string): boolean {
  return headers.some((header) => {
    const [pair, ...attributes] = header.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const cookieName = separator === -1 ? pair : pair.slice(0, separator);
    const value = separator === -1 ? '' : pair.slice(separator + 1);
    if (cookieName !== name) {
      return false;
    }

    const expired = attributes.some((attribute) => {
      const normalized = attribute.toLowerCase();
      return (
        normalized === 'max-age=0' ||
        normalized.startsWith('expires=thu, 01 jan 1970')
      );
    });

    return expired && value.length === 0;
  });
}

function assertPublicError(
  body: AuthBody,
  expected: { status?: never; code: string; message: string },
  secrets: Array<string | undefined> = [],
) {
  assert.ok(body.error);
  assert.equal(body.error?.code, expected.code);
  assert.equal(body.error?.message, expected.message);
  assert.deepEqual(
    Object.keys(body.error ?? {}).sort(),
    ['code', 'message', 'requestId'].sort(),
  );

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /\$argon2id\$/);
  assert.doesNotMatch(serialized, /"stack"/);
  assert.doesNotMatch(serialized, /password_hash|passwordHash/);
  assert.equal('details' in (body.error ?? {}), false);

  for (const secretValue of secrets) {
    if (secretValue) {
      assert.equal(serialized.includes(secretValue), false);
    }
  }
}

function assertSecurityHeaders(response: Response) {
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

function tamperJwtSignature(token: string): string {
  const parts = token.split('.');
  assert.equal(parts.length, 3);

  const signature = parts[2];
  const tamperedSignature = [...signature]
    .map((char) => (char === 'A' ? 'B' : 'A'))
    .join('');

  return `${parts[0]}.${parts[1]}.${tamperedSignature}`;
}

test('valid login succeeds', async () => {
  const { app, store } = await createHarness();
  const { response, body } = await login(app);

  assert.equal(response.status, 200);
  assert.equal(body.user?.id, userA);
  assert.equal(body.organization?.id, orgA);
  assert.equal(body.token_type, 'Bearer');
  assert.equal(typeof body.access_token, 'string');
  assert.equal(typeof body.refresh_token, 'string');
  assert.equal(typeof body.session_id, 'string');
  assert.equal((await store.listActiveSessions(userA)).length, 1);
  assertSecurityHeaders(response);

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(password), false);
  assert.doesNotMatch(serialized, /\$argon2id\$/);
});

test('wrong password returns 401 with a generic authentication failure', async () => {
  const { app } = await createHarness();
  const { response, body } = await login(app, 'user@example.com', wrongPassword);

  assert.equal(response.status, 401);
  assertPublicError(body, {
    code: 'INVALID_CREDENTIALS',
    message: genericAuthFailure,
  });
});

test('nonexistent account returns the same generic 401 and does not enumerate users', async () => {
  const { app } = await createHarness();
  const unknown = await login(app, 'missing@example.com', password);
  const wrong = await login(app, 'user@example.com', wrongPassword);

  assert.equal(unknown.response.status, 401);
  assert.equal(wrong.response.status, 401);
  assert.equal(unknown.body.error?.code, wrong.body.error?.code);
  assert.equal(unknown.body.error?.message, wrong.body.error?.message);
  assertPublicError(unknown.body, {
    code: 'INVALID_CREDENTIALS',
    message: genericAuthFailure,
  });
  assert.doesNotMatch(
    JSON.stringify(unknown.body),
    /not found|unknown account|does not exist|no user/i,
  );
});

test('repeated invalid login attempts are rate limited with Retry-After', async () => {
  const { app } = await createHarness();
  const emailLimit = 5;
  const failures: number[] = [];

  for (let attempt = 0; attempt < emailLimit; attempt += 1) {
    const { response, body } = await login(
      app,
      'user@example.com',
      wrongPassword,
    );
    failures.push(response.status);
    assert.equal(response.status, 401);
    assert.equal(body.error?.code, 'INVALID_CREDENTIALS');
  }

  const limited = await login(app, 'user@example.com', wrongPassword);
  const retryAfter = Number(limited.response.headers.get('Retry-After'));

  assert.deepEqual(failures, Array.from({ length: emailLimit }, () => 401));
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error?.code, 'RATE_LIMITED');
  assert.equal(Number.isInteger(retryAfter) && retryAfter > 0, true);
});

test('a valid access JWT authenticates /api/me', async () => {
  const { app } = await createHarness();
  const { body } = await login(app);
  const me = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  const meBody = await json(me);

  assert.equal(me.status, 200);
  assert.equal(meBody.user?.id, userA);
  assert.equal(meBody.organization?.id, orgA);
  assertSecurityHeaders(me);
});

test('tampering with the JWT signature returns 401', async () => {
  const { app } = await createHarness();
  const { body } = await login(app);
  const tampered = tamperJwtSignature(body.access_token!);
  const response = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${tampered}` },
  });
  const rejected = await json(response);

  assert.equal(tampered === body.access_token, false);
  assert.equal(response.status, 401);
  assertPublicError(rejected, {
    code: 'INVALID_CREDENTIAL',
    message: genericAuthRequired,
  });
});

test('refresh rotates tokens, rejects replay, and revokes the session', async () => {
  const { app, store } = await createHarness();
  const { body: issued } = await login(app);

  const rotatedResponse = await app.request('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: issued.refresh_token }),
  });
  const rotated = await json(rotatedResponse);

  assert.equal(rotatedResponse.status, 200);
  assert.equal(typeof rotated.access_token, 'string');
  assert.equal(typeof rotated.refresh_token, 'string');
  assert.equal(rotated.refresh_token === issued.refresh_token, false);
  assert.equal(rotated.user?.id, userA);
  assertSecurityHeaders(rotatedResponse);

  const me = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${rotated.access_token}` },
  });
  assert.equal(me.status, 200);

  const replayResponse = await app.request('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: issued.refresh_token }),
  });
  const replay = await json(replayResponse);

  assert.equal(replayResponse.status, 401);
  assertPublicError(
    replay,
    {
      code: 'REFRESH_TOKEN_REPLAY',
      message: genericAuthRequired,
    },
    [issued.refresh_token, rotated.refresh_token, issued.access_token],
  );
  assert.equal((await store.listActiveSessions(userA)).length, 0);

  const revokedResponse = await app.request('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rotated.refresh_token }),
  });
  const revoked = await json(revokedResponse);

  assert.equal(revokedResponse.status, 401);
  assertPublicError(
    revoked,
    {
      code: 'SESSION_REVOKED',
      message: 'The session is no longer valid.',
    },
    [issued.refresh_token, rotated.refresh_token],
  );
});

test('logout returns 200, clears auth cookies, and blocks later refresh', async () => {
  const { app, store } = await createHarness();
  const { response: loginResponse, body: issued } = await login(app);
  const loginCookies = setCookieHeaders(loginResponse);
  assert.equal(
    loginCookies.some((header) => header.startsWith(`${REFRESH_COOKIE}=`)),
    true,
  );
  assert.equal(
    loginCookies.some((header) => header.startsWith(`${CSRF_COOKIE}=`)),
    true,
  );

  const logoutResponse = await app.request('/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${issued.access_token}` },
  });
  const logout = await json(logoutResponse);
  const cleared = setCookieHeaders(logoutResponse);

  assert.equal(logoutResponse.status, 200);
  assert.equal(logout.revoked, true);
  assert.equal(cookieCleared(cleared, REFRESH_COOKIE), true);
  assert.equal(cookieCleared(cleared, CSRF_COOKIE), true);
  assert.equal((await store.listActiveSessions(userA)).length, 0);
  assertSecurityHeaders(logoutResponse);

  const refreshResponse = await app.request('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: issued.refresh_token }),
  });
  const refresh = await json(refreshResponse);

  assert.equal(refreshResponse.status, 401);
  assertPublicError(
    refresh,
    {
      code: 'SESSION_REVOKED',
      message: 'The session is no longer valid.',
    },
    [issued.refresh_token],
  );
});
