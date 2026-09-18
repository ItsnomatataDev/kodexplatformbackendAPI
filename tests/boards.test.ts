import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import type { AuthContext } from '../src/authorization/types.js';
import { MemoryBoardStore } from '../src/work/memory-store.js';
import { createSessionAuth } from './session-auth.js';

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const missingBoard = '99999999-9999-9999-9999-999999999999';

const tokenService = new AccessTokenService({
  secret: 'test-only-access-token-secret-value!!',
  issuer: 'kode-platform/test',
  audience: 'kode-platform-api/test',
  ttlSeconds: 900,
  clockToleranceSeconds: 0,
});
const sessionAuth = createSessionAuth(tokenService);

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
      officeId: null,
      roleId: 'role-1',
      roleKey: 'admin',
      status: 'active',
      isAdminRole: true,
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

function createBoardApp(
  store: MemoryBoardStore,
  resolve: (userId: string) => Promise<AuthContext>,
) {
  return createApp({
    auth: {
      verifier: tokenService,
      resolveAuthContext: resolve,
      requireActiveSession: (sessionId, userId) =>
        sessionAuth.requireActiveSession(sessionId, userId),
    },
    me: {
      loadPublicProfile: async () => null,
    },
    boards: store,
  });
}

async function json(response: Response) {
  return response.json() as Promise<{
    boards?: Array<{ id: string; organizationId: string; createdBy: string; name: string }>;
    board?: {
      id: string;
      organizationId: string;
      createdBy: string;
      name: string;
      description: string | null;
    };
    error?: { code: string; message: string };
  }>;
}

async function bearer(userId: string) {
  return (await sessionAuth.issueBearer(userId)).authorization;
}

test('unauthenticated board requests are denied', async () => {
  const app = createBoardApp(new MemoryBoardStore(), async () => authContext());
  const response = await app.request('/api/boards');
  const body = await json(response);

  assert.equal(response.status, 401);
  assert.equal(body.error?.code, 'MISSING_CREDENTIAL');
});

test('GET /api/projects is no longer available', async () => {
  const app = createBoardApp(new MemoryBoardStore(), async () => authContext());
  const response = await app.request('/api/projects', {
    headers: { Authorization: await bearer(userA) },
  });

  assert.equal(response.status, 404);
});

test('admins can create, list, read, and update organization-scoped boards', async () => {
  const store = new MemoryBoardStore();
  const app = createBoardApp(store, async () => authContext());
  const authorization = await bearer(userA);

  const empty = await json(
    await app.request('/api/boards', {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(empty.boards?.length, 0);

  const createdResponse = await app.request('/api/boards', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Delivery board',
      description: 'Work for the org',
      organizationId: orgB,
    }),
  });
  const created = await json(createdResponse);

  assert.equal(createdResponse.status, 403);
  assert.equal(created.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');

  const createdOkResponse = await app.request('/api/boards', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Delivery board' }),
  });
  const createdOk = await json(createdOkResponse);

  assert.equal(createdOkResponse.status, 201);
  assert.equal(createdOk.board?.name, 'Delivery board');
  assert.equal(createdOk.board?.organizationId, orgA);
  assert.equal(createdOk.board?.createdBy, userA);

  const listed = await json(
    await app.request('/api/boards', {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(listed.boards?.length, 1);
  assert.equal(listed.boards?.[0]?.id, createdOk.board?.id);

  const read = await json(
    await app.request(`/api/boards/${createdOk.board?.id}`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(read.board?.id, createdOk.board?.id);

  const patched = await json(
    await app.request(`/api/boards/${createdOk.board?.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Renamed board' }),
    }),
  );
  assert.equal(patched.board?.name, 'Renamed board');
});

test('board creation requires a name and ignores client identity fields', async () => {
  const app = createBoardApp(new MemoryBoardStore(), async () => authContext());
  const authorization = await bearer(userA);

  const missing = await json(
    await app.request('/api/boards', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ description: 'no name' }),
    }),
  );
  assert.equal(missing.error?.code, 'VALIDATION_ERROR');

  const userOverride = await json(
    await app.request('/api/boards', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'X-User-Id': userB,
      },
      body: JSON.stringify({ name: 'Board' }),
    }),
  );
  assert.equal(userOverride.error?.code, 'USER_OVERRIDE_REJECTED');
});

test('unknown and cross-organization boards are not found', async () => {
  const store = new MemoryBoardStore();
  const appA = createBoardApp(store, async (userId) => {
    if (userId !== userA) {
      throw new Error('unexpected user');
    }
    return authContext();
  });
  const appB = createBoardApp(store, async () =>
    authContext({
      actor: { userId: userB, email: 'other@example.com' },
      membership: {
        membershipId: 'membership-2',
        organizationId: orgB,
        roleId: 'role-2',
        roleKey: 'admin',
        status: 'active',
        isAdminRole: true,
        isManagerRole: false,
        permissions: {},
      },
      organization: {
        organizationId: orgB,
        isActive: true,
        status: 'active',
        accessStatus: 'active',
      },
    }),
  );

  const created = await json(
    await appA.request('/api/boards', {
      method: 'POST',
      headers: {
        Authorization: await bearer(userA),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Org A board' }),
    }),
  );

  const missing = await json(
    await appA.request(`/api/boards/${missingBoard}`, {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(missing.error?.code, 'BOARD_NOT_FOUND');

  const cross = await json(
    await appB.request(`/api/boards/${created.board?.id}`, {
      headers: { Authorization: await bearer(userB) },
    }),
  );
  assert.equal(cross.error?.code, 'BOARD_NOT_FOUND');

  const invalid = await json(
    await appA.request('/api/boards/not-a-uuid', {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(invalid.error?.code, 'VALIDATION_ERROR');
});

test('members without permission cannot create boards', async () => {
  const app = createBoardApp(new MemoryBoardStore(), async () =>
    authContext({
      membership: {
        membershipId: 'membership-1',
        organizationId: orgA,
        roleId: 'role-1',
        roleKey: 'member',
        status: 'active',
        isAdminRole: false,
        isManagerRole: false,
        permissions: {},
      },
    }),
  );

  const denied = await json(
    await app.request('/api/boards', {
      method: 'POST',
      headers: {
        Authorization: await bearer(userA),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Denied board' }),
    }),
  );

  assert.equal(denied.error?.code, 'INSUFFICIENT_PERMISSION');
});
