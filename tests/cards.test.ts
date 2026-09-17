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
const missingId = '99999999-9999-9999-9999-999999999999';

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
      requireActiveSession: (sessionId, userId) =>
        sessionAuth.requireActiveSession(sessionId, userId),
    },
    me: {
      loadPublicProfile: async () => null,
    },
    boards: store,
  });
}

type CardBody = {
  id: string;
  organizationId: string;
  boardId: string;
  columnId: string | null;
  title: string;
  description: string | null;
  statusKey: string;
  priority: string;
  department: string | null;
  dueAt: string | null;
  startAt: string | null;
  completedAt: string | null;
  blockedReason: string | null;
  aiGenerated: boolean;
  position: number;
  metadata: unknown;
  trackedSecondsCache: number;
  isBillable: boolean;
  estimatedSeconds: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

async function json(response: Response) {
  return response.json() as Promise<{
    board?: { id: string };
    column?: { id: string; boardId: string; statusKey: string | null };
    cards?: CardBody[];
    card?: CardBody;
    error?: { code: string; message: string };
  }>;
}

async function bearer(userId: string) {
  return (await sessionAuth.issueBearer(userId)).authorization;
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

async function createColumn(
  app: ReturnType<typeof createApp>,
  userId: string,
  boardId: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const response = await json(
    await app.request(`/api/boards/${boardId}/columns`, {
      method: 'POST',
      headers: {
        Authorization: await bearer(userId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, ...extra }),
    }),
  );

  return response.column!.id;
}

async function createCard(
  app: ReturnType<typeof createApp>,
  userId: string,
  boardId: string,
  body: Record<string, unknown>,
) {
  return json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: await bearer(userId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
}

test('unauthenticated card requests are denied', async () => {
  const app = createWorkApp(new MemoryBoardStore(), async () => authContext());
  const boardId = await createBoard(app, userA, 'Board');

  const getBoardCards = await json(
    await app.request(`/api/boards/${boardId}/cards`),
  );
  const post = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Card', columnId: missingId }),
    }),
  );
  const getCard = await json(await app.request(`/api/cards/${missingId}`));
  const patch = await json(
    await app.request(`/api/cards/${missingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated' }),
    }),
  );

  assert.equal(getBoardCards.error?.code, 'MISSING_CREDENTIAL');
  assert.equal(post.error?.code, 'MISSING_CREDENTIAL');
  assert.equal(getCard.error?.code, 'MISSING_CREDENTIAL');
  assert.equal(patch.error?.code, 'MISSING_CREDENTIAL');
});

test('cards can be created, listed, read, and updated in the authenticated organization', async () => {
  const store = new MemoryBoardStore();
  const app = createWorkApp(store, async () => authContext());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Delivery');
  const columnId = await createColumn(app, userA, boardId, 'To Do', {
    statusKey: 'todo',
  });

  const rejectedOrg = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Implement Cards API',
        columnId,
        organizationId: orgB,
      }),
    }),
  );
  assert.equal(rejectedOrg.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');

  const rejectedIdentity = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Implement Cards API',
        columnId,
        createdBy: userB,
      }),
    }),
  );
  assert.equal(rejectedIdentity.error?.code, 'USER_OVERRIDE_REJECTED');

  const createdResponse = await app.request(`/api/boards/${boardId}/cards`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Implement Cards API',
      columnId,
    }),
  });
  const created = await json(createdResponse);

  assert.equal(createdResponse.status, 201);
  assert.equal(created.card?.title, 'Implement Cards API');
  assert.equal(created.card?.organizationId, orgA);
  assert.equal(created.card?.boardId, boardId);
  assert.equal(created.card?.columnId, columnId);
  assert.equal(created.card?.statusKey, 'todo');
  assert.equal(created.card?.priority, 'normal');
  assert.equal(created.card?.position, 0);
  assert.equal(created.card?.aiGenerated, false);
  assert.equal(created.card?.isBillable, false);
  assert.equal(created.card?.estimatedSeconds, 0);
  assert.equal(created.card?.trackedSecondsCache, 0);
  assert.deepEqual(created.card?.metadata, {});

  const stored = await store.getCardById(orgA, created.card!.id);
  assert.equal(stored?.title, 'Implement Cards API');
  assert.equal(stored?.organizationId, orgA);
  assert.equal(stored?.boardId, boardId);
  assert.equal(stored?.columnId, columnId);

  const listed = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(listed.cards?.length, 1);
  assert.equal(listed.cards?.[0]?.id, created.card?.id);

  const read = await json(
    await app.request(`/api/cards/${created.card?.id}`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(read.card?.id, created.card?.id);
  assert.equal(read.card?.title, 'Implement Cards API');

  const originalUpdatedAt = created.card!.updatedAt;
  const patchedResponse = await app.request(`/api/cards/${created.card?.id}`, {
    method: 'PATCH',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Cards API in review',
      description: 'Core lifecycle',
      statusKey: 'doing',
      priority: 'high',
      position: 4,
      completedAt: '2026-09-17T10:00:00.000Z',
    }),
  });
  const patched = await json(patchedResponse);

  assert.equal(patchedResponse.status, 200);
  assert.equal(patched.card?.title, 'Cards API in review');
  assert.equal(patched.card?.description, 'Core lifecycle');
  assert.equal(patched.card?.statusKey, 'doing');
  assert.equal(patched.card?.priority, 'high');
  assert.equal(patched.card?.position, 4);
  assert.equal(patched.card?.completedAt, '2026-09-17T10:00:00.000Z');
  assert.equal(patched.card!.updatedAt > originalUpdatedAt, true);
});

test('board cards are ordered by position and scoped to the board', async () => {
  const app = createWorkApp(new MemoryBoardStore(), async () => authContext());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Delivery');
  const otherBoardId = await createBoard(app, userA, 'Other');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const otherColumnId = await createColumn(app, userA, otherBoardId, 'Backlog');

  await createCard(app, userA, boardId, {
    title: 'Third',
    columnId,
    position: 2,
  });
  await createCard(app, userA, boardId, {
    title: 'First',
    columnId,
    position: 0,
  });
  await createCard(app, userA, boardId, {
    title: 'Second',
    columnId,
    position: 1,
  });
  await createCard(app, userA, otherBoardId, {
    title: 'Other board card',
    columnId: otherColumnId,
  });

  const listed = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      headers: { Authorization: authorization },
    }),
  );

  assert.deepEqual(
    listed.cards?.map((card) => card.title),
    ['First', 'Second', 'Third'],
  );
  assert.equal(
    listed.cards?.every((card) => card.boardId === boardId),
    true,
  );
});

test('cards can move to another column on the same board only', async () => {
  const store = new MemoryBoardStore();
  const appA = createWorkApp(store, async () => authContext());
  const appB = createWorkApp(store, async () => orgBContext());
  const authorization = await bearer(userA);

  const boardA = await createBoard(appA, userA, 'Board A');
  const boardB = await createBoard(appA, userA, 'Board B');
  const columnA1 = await createColumn(appA, userA, boardA, 'To Do');
  const columnA2 = await createColumn(appA, userA, boardA, 'Doing');
  const columnB1 = await createColumn(appA, userA, boardB, 'Board B To Do');

  const orgBBoard = await createBoard(appB, userB, 'Org B Board');
  const orgBColumn = await createColumn(appB, userB, orgBBoard, 'Org B To Do');

  const created = await createCard(appA, userA, boardA, {
    title: 'Movable card',
    columnId: columnA1,
  });
  assert.equal(created.card?.columnId, columnA1);

  const moved = await json(
    await appA.request(`/api/cards/${created.card?.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ columnId: columnA2 }),
    }),
  );
  assert.equal(moved.card?.columnId, columnA2);
  assert.equal(moved.card?.boardId, boardA);

  const crossBoard = await json(
    await appA.request(`/api/cards/${created.card?.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ columnId: columnB1 }),
    }),
  );
  assert.equal(crossBoard.error?.code, 'VALIDATION_ERROR');

  const createCrossBoard = await json(
    await appA.request(`/api/boards/${boardA}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Wrong column',
        columnId: columnB1,
      }),
    }),
  );
  assert.equal(createCrossBoard.error?.code, 'VALIDATION_ERROR');

  const createCrossOrg = await json(
    await appA.request(`/api/boards/${boardA}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Org B column',
        columnId: orgBColumn,
      }),
    }),
  );
  assert.equal(createCrossOrg.error?.code, 'COLUMN_NOT_FOUND');
});

test('card validation rejects missing titles, invalid columns, and invalid field values', async () => {
  const app = createWorkApp(new MemoryBoardStore(), async () => authContext());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Delivery');
  const columnId = await createColumn(app, userA, boardId, 'To Do');

  const missingTitle = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ columnId }),
    }),
  );
  assert.equal(missingTitle.error?.code, 'VALIDATION_ERROR');

  const emptyTitle = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: '   ', columnId }),
    }),
  );
  assert.equal(emptyTitle.error?.code, 'VALIDATION_ERROR');

  const invalidColumn = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Card', columnId: missingId }),
    }),
  );
  assert.equal(invalidColumn.error?.code, 'COLUMN_NOT_FOUND');

  const invalidPosition = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Card', columnId, position: 1.5 }),
    }),
  );
  assert.equal(invalidPosition.error?.code, 'VALIDATION_ERROR');

  const invalidEstimated = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Card',
        columnId,
        estimatedSeconds: 'soon',
      }),
    }),
  );
  assert.equal(invalidEstimated.error?.code, 'VALIDATION_ERROR');

  const invalidBoolean = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Card',
        columnId,
        isBillable: 'yes',
      }),
    }),
  );
  assert.equal(invalidBoolean.error?.code, 'VALIDATION_ERROR');

  const invalidDueAt = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Card',
        columnId,
        dueAt: 'not-a-date',
      }),
    }),
  );
  assert.equal(invalidDueAt.error?.code, 'VALIDATION_ERROR');
});

test('cards cannot be accessed or updated across organizations', async () => {
  const store = new MemoryBoardStore();
  const appA = createWorkApp(store, async () => authContext());
  const appB = createWorkApp(store, async () => orgBContext());
  const boardId = await createBoard(appA, userA, 'Org A board');
  const columnId = await createColumn(appA, userA, boardId, 'To Do');
  const created = await createCard(appA, userA, boardId, {
    title: 'Org A card',
    columnId,
  });

  const list = await json(
    await appB.request(`/api/boards/${boardId}/cards`, {
      headers: { Authorization: await bearer(userB) },
    }),
  );
  assert.equal(list.error?.code, 'BOARD_NOT_FOUND');

  const read = await json(
    await appB.request(`/api/cards/${created.card?.id}`, {
      headers: { Authorization: await bearer(userB) },
    }),
  );
  assert.equal(read.error?.code, 'CARD_NOT_FOUND');

  const patch = await json(
    await appB.request(`/api/cards/${created.card?.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: await bearer(userB),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Stolen' }),
    }),
  );
  assert.equal(patch.error?.code, 'CARD_NOT_FOUND');

  const missing = await json(
    await appA.request(`/api/cards/${missingId}`, {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(missing.error?.code, 'CARD_NOT_FOUND');
});
