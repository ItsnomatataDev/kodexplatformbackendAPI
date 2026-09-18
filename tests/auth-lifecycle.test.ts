import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import { CapturingEmailSender } from '../src/auth/email.js';
import { LoginService } from '../src/auth/login.js';
import { MemoryAuthStore } from '../src/auth/memory-store.js';
import { MemoryRateLimiter, type RateLimiter } from '../src/auth/rate-limit.js';
import { PasswordService } from '../src/auth/password-service.js';
import { hashPassword, isArgon2idHash, verifyPassword } from '../src/auth/passwords.js';
import { SessionService, onAccountAccessRevoked } from '../src/auth/sessions.js';
import type { AuthContext } from '../src/authorization/types.js';
import { UnauthorizedError } from '../src/http/errors.js';

const userA = '11111111-1111-1111-1111-111111111111';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const secret = 'test-only-access-token-secret-value!!';
const password = 'correct-horse-battery';
const corsOrigins = ['http://127.0.0.1:5173'];

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

async function json(response: Response) {
  return response.json() as Promise<{
    access_token?: string;
    refresh_token?: string;
    session_id?: string;
    user?: { id: string };
    organization?: { id: string };
    error?: { code: string; message: string };
    revoked?: boolean | number;
    reset?: boolean;
    message?: string;
  }>;
}

function denyingLimiter(): RateLimiter {
  return {
    async consume() {
      return { allowed: false, retryAfterSeconds: 42 };
    },
  };
}

async function createHarness(options: {
  accountStatus?: AuthContext['actor']['accountStatus'];
  isActive?: boolean;
  rateLimiter?: RateLimiter;
} = {}) {
  const store = new MemoryAuthStore();
  const passwordHash = await hashPassword(password);
  store.seedUser({
    userId: userA,
    email: 'user@example.com',
    emailNormalized: 'user@example.com',
    isActive: options.isActive ?? true,
    accountStatus: options.accountStatus ?? 'active',
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

  const resolve = async (userId: string) => {
    if (userId !== userA) {
      throw new UnauthorizedError(
        'IDENTITY_NOT_FOUND',
        'The authenticated identity is no longer valid.',
      );
    }

    const context = authContext();
    context.actor.accountStatus = options.accountStatus ?? 'active';
    context.actor.isActive = options.isActive ?? true;
    return context;
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
      rateLimiter: options.rateLimiter ?? new MemoryRateLimiter(['test']),
      cookies: {
        secure: false,
        refreshMaxAgeSeconds: 3_600,
      },
    },
    corsOrigins,
  });

  return { app, store, sessions, email, passwordHash };
}

test('password is stored and verified as Argon2id', async () => {
  const hash = await hashPassword(password);
  assert.equal(isArgon2idHash(hash), true);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, 'wrong-password-value'), false);
});

test('valid login creates a session and returns tokens for the server identity', async () => {
  const { app, store } = await createHarness();
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'User@example.com', password }),
  });
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.user?.id, userA);
  assert.equal(body.organization?.id, orgA);
  assert.equal(typeof body.access_token, 'string');
  assert.equal(typeof body.refresh_token, 'string');
  assert.equal((await store.listActiveSessions(userA)).length, 1);
  const serialized = JSON.stringify(body);
  assert.equal('password_hash' in body, false);
  assert.equal('passwordHash' in body, false);
  assert.doesNotMatch(serialized, /\$argon2id\$/);
  assert.doesNotMatch(serialized, new RegExp(password));

  const me = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  const meBody = await json(me);
  assert.equal(me.status, 200);
  assert.equal(meBody.user?.id, userA);
});

test('invalid password and unknown account return the same generic failure', async () => {
  const { app } = await createHarness();

  const wrong = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'wrong-password-value' }),
    }),
  );
  const unknown = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.com', password }),
    }),
  );

  assert.equal(wrong.error?.code, 'INVALID_CREDENTIALS');
  assert.equal(unknown.error?.code, 'INVALID_CREDENTIALS');
  assert.equal(wrong.error?.message, unknown.error?.message);
});

test('suspended and inactive accounts cannot log in', async () => {
  const suspended = await createHarness({ accountStatus: 'suspended' });
  const inactive = await createHarness({ isActive: false });

  const suspendedBody = await json(
    await suspended.app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );
  const inactiveBody = await json(
    await inactive.app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );

  assert.equal(suspendedBody.error?.code, 'ACCOUNT_SUSPENDED');
  assert.equal(inactiveBody.error?.code, 'ACCOUNT_INACTIVE');
});

test('refresh rotates the token and rejects replay by revoking the session', async () => {
  const { app, store } = await createHarness();
  const login = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );

  const refreshed = await json(
    await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: login.refresh_token }),
    }),
  );

  assert.equal(typeof refreshed.refresh_token, 'string');
  assert.notEqual(refreshed.refresh_token, login.refresh_token);

  const replay = await json(
    await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: login.refresh_token }),
    }),
  );

  assert.equal(replay.error?.code, 'REFRESH_TOKEN_REPLAY');
  assert.equal((await store.listActiveSessions(userA)).length, 0);

  const rotatedReplay = await json(
    await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshed.refresh_token }),
    }),
  );
  assert.equal(rotatedReplay.error?.code, 'SESSION_REVOKED');
});

test('expired and revoked refresh tokens are denied', async () => {
  const expiredHarness = await createHarness();
  const expiredLogin = await json(
    await expiredHarness.app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );
  const { hashOpaqueToken } = await import('../src/auth/opaque-token.js');
  expiredHarness.store.expireRefreshToken(
    hashOpaqueToken(secret, expiredLogin.refresh_token!),
    new Date(Date.now() - 1000),
  );
  const expired = await json(
    await expiredHarness.app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: expiredLogin.refresh_token }),
    }),
  );
  assert.equal(expired.error?.code, 'EXPIRED_REFRESH_TOKEN');

  const revokedHarness = await createHarness();
  const revokedLogin = await json(
    await revokedHarness.app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );
  const session = (await revokedHarness.store.listActiveSessions(userA))[0];
  await revokedHarness.sessions.revokeSession(session.id, 'logout');
  const revoked = await json(
    await revokedHarness.app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: revokedLogin.refresh_token }),
    }),
  );
  assert.equal(revoked.error?.code, 'SESSION_REVOKED');
});

test('logout and logout-all revoke the authenticated sessions only', async () => {
  const { app, store } = await createHarness();
  const first = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );
  const second = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );

  const logout = await json(
    await app.request('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${first.access_token}` },
    }),
  );
  assert.equal(logout.revoked, true);
  assert.equal((await store.listActiveSessions(userA)).length, 1);

  const logoutAll = await json(
    await app.request('/auth/logout-all', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${second.access_token}`,
        'X-User-Id': '22222222-2222-2222-2222-222222222222',
      },
    }),
  );
  assert.equal(logoutAll.error?.code, 'USER_OVERRIDE_REJECTED');

  const logoutAllOk = await json(
    await app.request('/auth/logout-all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${second.access_token}` },
    }),
  );
  assert.equal(logoutAllOk.revoked, 1);
  assert.equal((await store.listActiveSessions(userA)).length, 0);
});

test('account suspension and deactivation revoke active sessions', async () => {
  const { app, sessions } = await createHarness();
  const login = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );

  await onAccountAccessRevoked(sessions, userA, 'account_suspended');
  const refresh = await json(
    await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: login.refresh_token }),
    }),
  );
  assert.equal(refresh.error?.code, 'SESSION_REVOKED');

  const again = await createHarness();
  const secondLogin = await json(
    await again.app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );
  await onAccountAccessRevoked(again.sessions, userA, 'account_inactive');
  const inactiveRefresh = await json(
    await again.app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: secondLogin.refresh_token }),
    }),
  );
  assert.equal(inactiveRefresh.error?.code, 'SESSION_REVOKED');
});

test('password change requires the current password and invalidates other sessions', async () => {
  const { app, store } = await createHarness();
  const original = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );

  const denied = await json(
    await app.request('/auth/password/change', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${original.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        current_password: 'wrong-password-value',
        new_password: 'brand-new-password',
      }),
    }),
  );
  assert.equal(denied.error?.code, 'INVALID_CREDENTIALS');

  const changed = await json(
    await app.request('/auth/password/change', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${original.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        current_password: password,
        new_password: 'brand-new-password',
      }),
    }),
  );
  assert.equal(changed.user?.id, userA);
  assert.equal((await store.listActiveSessions(userA)).length, 1);

  const oldRefresh = await json(
    await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: original.refresh_token }),
    }),
  );
  assert.ok(
    oldRefresh.error?.code === 'SESSION_REVOKED' ||
      oldRefresh.error?.code === 'REFRESH_TOKEN_REPLAY' ||
      oldRefresh.error?.code === 'INVALID_REFRESH_TOKEN',
  );

  const oldPasswordLogin = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );
  assert.equal(oldPasswordLogin.error?.code, 'INVALID_CREDENTIALS');

  const newPasswordLogin = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'brand-new-password',
      }),
    }),
  );
  assert.equal(newPasswordLogin.user?.id, userA);
  assert.equal((await store.listActiveSessions(userA)).length, 2);
});

test('password reset does not reveal accounts and invalidates sessions after a valid confirm', async () => {
  const { app, email, store } = await createHarness();
  const login = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );

  const known = await json(
    await app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    }),
  );
  const unknown = await json(
    await app.request('/auth/password/reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.com' }),
    }),
  );
  assert.equal(known.message, unknown.message);
  assert.ok(email.lastReset?.resetToken);

  const expired = await json(
    await app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'not-the-token',
        new_password: 'reset-password-1',
      }),
    }),
  );
  assert.equal(expired.error?.code, 'INVALID_RESET_TOKEN');

  const resetToken = email.lastReset!.resetToken;
  const confirm = await json(
    await app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: resetToken,
        new_password: 'reset-password-1',
      }),
    }),
  );
  assert.equal(confirm.reset, true);
  assert.equal((await store.listActiveSessions(userA)).length, 0);

  const reused = await json(
    await app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: resetToken,
        new_password: 'reset-password-2',
      }),
    }),
  );
  assert.equal(reused.error?.code, 'INVALID_RESET_TOKEN');

  const oldRefresh = await json(
    await app.request('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: login.refresh_token }),
    }),
  );
  assert.ok(oldRefresh.error);
});

test('a second reset request invalidates the previous unused token', async () => {
  const { app, email } = await createHarness();

  await app.request('/auth/password/reset/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com' }),
  });
  const firstToken = email.lastReset!.resetToken;

  await app.request('/auth/password/reset/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com' }),
  });
  const secondToken = email.lastReset!.resetToken;

  const first = await json(
    await app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: firstToken,
        new_password: 'reset-password-1',
      }),
    }),
  );
  assert.equal(first.error?.code, 'INVALID_RESET_TOKEN');

  const second = await json(
    await app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: secondToken,
        new_password: 'reset-password-1',
      }),
    }),
  );
  assert.equal(second.reset, true);

  const reused = await json(
    await app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: secondToken,
        new_password: 'reset-password-2',
      }),
    }),
  );
  assert.equal(reused.error?.code, 'INVALID_RESET_TOKEN');
});

test('expired reset tokens are rejected', async () => {
  const { app, email, store } = await createHarness();
  await app.request('/auth/password/reset/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com' }),
  });
  const token = email.lastReset!.resetToken;
  const { hashOpaqueToken } = await import('../src/auth/opaque-token.js');
  store.expirePasswordResetToken(
    hashOpaqueToken(secret, token),
    new Date(Date.now() - 1000),
  );

  const confirm = await json(
    await app.request('/auth/password/reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        new_password: 'reset-password-1',
      }),
    }),
  );
  assert.equal(confirm.error?.code, 'EXPIRED_RESET_TOKEN');
});

test('login, refresh, and reset request are rate limited', async () => {
  const { app } = await createHarness({ rateLimiter: denyingLimiter() });

  for (const path of [
    '/auth/login',
    '/auth/refresh',
    '/auth/password/reset/request',
    '/auth/password/reset/confirm',
  ]) {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        password,
        refresh_token: 'x',
        token: 'x',
        new_password: 'twelvechars!!',
      }),
    });
    const body = await json(response);
    assert.equal(response.status, 429);
    assert.equal(body.error?.code, 'RATE_LIMITED');
    assert.equal(response.headers.get('Retry-After'), '42');
  }
});

test('cookie-backed mutating requests require an allowed origin and CSRF token', async () => {
  const { app } = await createHarness();
  const rejected = await json(
    await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: 'kode_csrf=test-csrf-token',
        Authorization: 'Bearer abc',
      },
    }),
  );
  assert.equal(rejected.error?.code, 'CSRF_ORIGIN_REQUIRED');

  const originRejected = await json(
    await app.request('/auth/login', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'user@example.com', password }),
    }),
  );
  assert.equal(originRejected.error?.code, 'CSRF_ORIGIN_REJECTED');
});
