import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import { extractBearerToken } from '../src/auth/credential.js';
import { UnauthorizedError } from '../src/http/errors.js';
import type { AuthContext } from '../src/authorization/types.js';

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const tokenService = new AccessTokenService({
  secret: 'test-only-access-token-secret-value!!',
  issuer: 'kode-platform/test',
  audience: 'kode-platform-api/test',
  ttlSeconds: 900,
  clockToleranceSeconds: 0,
});

function authContext(
  overrides: {
    actor?: Partial<AuthContext['actor']>;
    membership?: Partial<AuthContext['membership']>;
    organization?: Partial<AuthContext['organization']>;
  } = {},
): AuthContext {
  return {
    actor: {
      userId: userA,
      email: 'user@example.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
      ...overrides.actor,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId: orgA,
      roleId: 'role-1',
      roleKey: 'member',
      status: 'active',
      isAdminRole: false,
      isManagerRole: false,
      permissions: {},
      ...overrides.membership,
    },
    organization: {
      organizationId: orgA,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
      ...overrides.organization,
    },
  };
}

function createTestApp(
  resolve: (userId: string) => Promise<AuthContext>,
) {
  return createApp({
    auth: {
      verifier: tokenService,
      resolveAuthContext: resolve,
    },
    me: {
      loadPublicProfile: async () => ({
        fullName: 'Test User',
        avatarUrl: null,
        jobTitle: 'Engineer',
        department: 'Platform',
        employeeCode: 'E-1',
        username: 'test.user',
      }),
    },
  });
}

async function json(response: Response) {
  return response.json() as Promise<{
    user?: { id: string };
    membership?: { organizationId: string };
    organization?: { id: string };
    error?: { code: string; message: string };
    status?: string;
    service?: string;
  }>;
}

test('missing credential is denied', async () => {
  assert.deepEqual(extractBearerToken(undefined), {
    ok: false,
    code: 'MISSING_CREDENTIAL',
    message: 'Authentication is required.',
  });

  const app = createTestApp(async () => authContext());
  const response = await app.request('/api/me');
  const body = await json(response);

  assert.equal(response.status, 401);
  assert.equal(body.error?.code, 'MISSING_CREDENTIAL');
});

test('malformed credential is denied', async () => {
  const malformed = ['Bearer', 'Bearer ', 'Basic abc', 'Token abc', 'bearer'];

  for (const header of malformed) {
    const extracted = extractBearerToken(header);
    assert.equal(extracted.ok, false);
    if (!extracted.ok) {
      assert.equal(extracted.code, 'MALFORMED_CREDENTIAL');
    }
  }

  const app = createTestApp(async () => authContext());
  const response = await app.request('/api/me', {
    headers: { Authorization: 'Basic abc' },
  });
  const body = await json(response);

  assert.equal(response.status, 401);
  assert.equal(body.error?.code, 'MALFORMED_CREDENTIAL');
});

test('invalid credential is denied', async () => {
  const otherService = new AccessTokenService({
    secret: 'other-test-access-token-secret-value',
    issuer: 'kode-platform/test',
    audience: 'kode-platform-api/test',
    ttlSeconds: 900,
    clockToleranceSeconds: 0,
  });
  const token = await otherService.issue(userA);
  const app = createTestApp(async () => authContext());
  const response = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(response);

  const garbage = await app.request('/api/me', {
    headers: { Authorization: 'Bearer not-a-jwt' },
  });
  const garbageBody = await json(garbage);

  assert.equal(response.status, 401);
  assert.equal(body.error?.code, 'INVALID_CREDENTIAL');
  assert.equal(body.error?.message, 'Authentication is required.');
  assert.equal(garbage.status, 401);
  assert.equal(garbageBody.error?.code, 'INVALID_CREDENTIAL');
});

test('expired credential is denied', async () => {
  const token = await tokenService.issue(userA, {
    expiresAt: new Date(Date.now() - 30_000),
  });
  const app = createTestApp(async () => authContext());
  const response = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(response);

  assert.equal(response.status, 401);
  assert.equal(body.error?.code, 'EXPIRED_CREDENTIAL');
});

test('valid credential authenticates the token subject, not a client user id', async () => {
  const token = await tokenService.issue(userA);
  let resolvedUserId: string | undefined;

  const app = createTestApp(async (userId) => {
    resolvedUserId = userId;
    return authContext();
  });

  const response = await app.request('/api/me', {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-User-Id': userB,
    },
  });
  const body = await json(response);

  assert.equal(response.status, 403);
  assert.equal(body.error?.code, 'USER_OVERRIDE_REJECTED');
  assert.equal(resolvedUserId, userA);
});

test('authenticated user maps to the correct user id and organization context', async () => {
  const token = await tokenService.issue(userA);
  const app = createTestApp(async (userId) => {
    assert.equal(userId, userA);
    return authContext();
  });

  const response = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.user?.id, userA);
  assert.equal(body.membership?.organizationId, orgA);
  assert.equal(body.organization?.id, orgA);
});

test('suspended user is denied', async () => {
  const token = await tokenService.issue(userA);
  const app = createTestApp(async () =>
    authContext({ actor: { accountStatus: 'suspended' } }),
  );
  const response = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(response);

  assert.equal(response.status, 403);
  assert.equal(body.error?.code, 'ACCOUNT_SUSPENDED');
});

test('inactive user is denied', async () => {
  const token = await tokenService.issue(userA);
  const app = createTestApp(async () =>
    authContext({ actor: { isActive: false } }),
  );
  const response = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(response);

  assert.equal(response.status, 403);
  assert.equal(body.error?.code, 'ACCOUNT_INACTIVE');
});

test('authenticated identity that no longer exists is denied', async () => {
  const token = await tokenService.issue(userA);
  const app = createTestApp(async () => {
    throw new UnauthorizedError(
      'IDENTITY_NOT_FOUND',
      'The authenticated identity is no longer valid.',
    );
  });
  const response = await app.request('/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(response);

  assert.equal(response.status, 401);
  assert.equal(body.error?.code, 'IDENTITY_NOT_FOUND');
});

test('client organization id cannot override membership', async () => {
  const token = await tokenService.issue(userA);
  const app = createTestApp(async () => authContext());
  const response = await app.request(
    `/api/me?organization_id=${orgB}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const body = await json(response);

  assert.equal(response.status, 403);
  assert.equal(body.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');
});

test('protected route requires authentication and health does not', async () => {
  const app = createTestApp(async () => authContext());

  const protectedResponse = await app.request('/api/me');
  const protectedBody = await json(protectedResponse);
  const liveResponse = await app.request('/health/live');
  const liveBody = await json(liveResponse);

  assert.equal(protectedResponse.status, 401);
  assert.equal(protectedBody.error?.code, 'MISSING_CREDENTIAL');
  assert.equal(liveResponse.status, 200);
  assert.equal(liveBody.status, 'ok');
  assert.equal(liveBody.service, 'kode-platform');
});
