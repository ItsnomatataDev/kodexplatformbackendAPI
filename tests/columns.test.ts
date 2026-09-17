import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import type { AuthContext } from '../src/authorization/types.js';
import { MemoryBoardStore } from '../src/work/memory-store.js';

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const missingId = '99999999-9999-9999-9999-999999999999';

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

function orgBContext(): AuthContext {
  return authContext({
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
  });
}

function createWorkApp(
  store: MemoryBoardStore,
  resolve: (userId: string) => Promise<AuthContext>,
) {
  return createApp({
    auth: {
      verifier: tokenService,
      resolveAuthContext: resolve,
    },
    me: {
      loadPublicProfile: async () => null,
    },
    boards: store,
  });
}

async function json(response: Response) {
  return response.json() as Promise<{
    board?: { id: string };
    columns?: Array<{
      id: string;
      organizationId: string;
      boardId: string;
      name: string;
      position: number;
    }>;
    column?: {
      id: string;
      organizationId: string;
      boardId: string;
      name: string;
      color: string | null;
      statusKey: string | null;
      position: number;
      createdAt: string;
      updatedAt: string;
    };
    error?: { code: string; message: string };
  }>;
}

async function bearer(userId: string) {
  return `Bearer ${await tokenService.issue(userId)}`;
}

async function createBoard(
  app: ReturnType<typeof createApp>,
  userId: string,
  name: string,
) {
  const response = await json(
    await app.request('/api/boards', {
      method: 'POST',
      headers: {
        Authorization: await bearer(userId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    }),
  );

  return response.board!.id;
}

test('unauthenticated column requests are denied', async () => {
  const store = new MemoryBoardStore();
  const app = createWorkApp(store, async () => authContext());
  const boardId = await createBoard(app, userA, 'Board');

  const get = await json(await app.request(`/api/boards/${boardId}/columns`));
  const post = await json(
    await app.request(`/api/boards/${boardId}/columns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To Do' }),
    }),
  );
  const patch = await json(
    await app.request(`/api/columns/${missingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Done' }),
    }),
  );

  assert.equal(get.error?.code, 'MISSING_CREDENTIAL');
  assert.equal(post.error?.code, 'MISSING_CREDENTIAL');
  assert.equal(patch.error?.code, 'MISSING_CREDENTIAL');
});

test('columns can be created, listed, and updated for a board in the authenticated organization', async () => {
  const app = createWorkApp(new MemoryBoardStore(), async () => authContext());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Delivery');

  const createdResponse = await app.request(`/api/boards/${boardId}/columns`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'To Do',
      color: null,
      statusKey: 'todo',
      position: 0,
      organizationId: orgB,
    }),
  });
  const rejected = await json(createdResponse);
  assert.equal(createdResponse.status, 403);
  assert.equal(rejected.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');

  const createdOkResponse = await app.request(`/api/boards/${boardId}/columns`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'To Do',
      color: null,
      statusKey: 'todo',
      position: 0,
    }),
  });
  const created = await json(createdOkResponse);

  assert.equal(createdOkResponse.status, 201);
  assert.equal(created.column?.name, 'To Do');
  assert.equal(created.column?.organizationId, orgA);
  assert.equal(created.column?.boardId, boardId);
  assert.equal(created.column?.statusKey, 'todo');
  assert.equal(created.column?.position, 0);

  const listed = await json(
    await app.request(`/api/boards/${boardId}/columns`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(listed.columns?.length, 1);
  assert.equal(listed.columns?.[0]?.id, created.column?.id);

  const originalUpdatedAt = created.column!.updatedAt;
  const patchedResponse = await app.request(
    `/api/columns/${created.column?.id}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'In Progress',
        statusKey: 'doing',
        position: 1,
      }),
    },
  );
  const patched = await json(patchedResponse);

  assert.equal(patchedResponse.status, 200);
  assert.equal(patched.column?.name, 'In Progress');
  assert.equal(patched.column?.statusKey, 'doing');
  assert.equal(patched.column?.position, 1);
  assert.equal(patched.column?.boardId, boardId);
  assert.equal(patched.column!.updatedAt > originalUpdatedAt, true);
});

test('column validation rejects missing names, invalid positions, and boardId changes', async () => {
  const app = createWorkApp(new MemoryBoardStore(), async () => authContext());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Delivery');

  const missingName = await json(
    await app.request(`/api/boards/${boardId}/columns`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ statusKey: 'todo' }),
    }),
  );
  assert.equal(missingName.error?.code, 'VALIDATION_ERROR');

  const invalidPosition = await json(
    await app.request(`/api/boards/${boardId}/columns`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'To Do', position: 1.5 }),
    }),
  );
  assert.equal(invalidPosition.error?.code, 'VALIDATION_ERROR');

  const created = await json(
    await app.request(`/api/boards/${boardId}/columns`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'To Do' }),
    }),
  );

  const moved = await json(
    await app.request(`/api/columns/${created.column?.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ boardId: missingId }),
    }),
  );
  assert.equal(moved.error?.code, 'VALIDATION_ERROR');
});

test('columns cannot be accessed across organizations', async () => {
  const store = new MemoryBoardStore();
  const appA = createWorkApp(store, async () => authContext());
  const appB = createWorkApp(store, async () => orgBContext());
  const boardId = await createBoard(appA, userA, 'Org A board');
  const created = await json(
    await appA.request(`/api/boards/${boardId}/columns`, {
      method: 'POST',
      headers: {
        Authorization: await bearer(userA),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'To Do' }),
    }),
  );

  const list = await json(
    await appB.request(`/api/boards/${boardId}/columns`, {
      headers: { Authorization: await bearer(userB) },
    }),
  );
  assert.equal(list.error?.code, 'BOARD_NOT_FOUND');

  const patch = await json(
    await appB.request(`/api/columns/${created.column?.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: await bearer(userB),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Stolen' }),
    }),
  );
  assert.equal(patch.error?.code, 'COLUMN_NOT_FOUND');
});
