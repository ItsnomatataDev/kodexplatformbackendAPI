import { createApp, type CreateAppOptions } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import type { AuthContext } from '../src/authorization/types.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { MemoryBoardStore } from '../src/work/memory-store.js';
import { createSessionAuth } from './session-auth.js';

export const userA = '11111111-1111-1111-1111-111111111111';
export const userB = '22222222-2222-2222-2222-222222222222';
export const userC = '33333333-3333-3333-3333-333333333333';
export const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const missingId = '99999999-9999-9999-9999-999999999999';

export const tokenService = new AccessTokenService({
  secret: 'test-only-access-token-secret-value!!',
  issuer: 'kode-platform/test',
  audience: 'kode-platform-api/test',
  ttlSeconds: 900,
  clockToleranceSeconds: 0,
});

export function authContext(
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

export function orgBContext(): AuthContext {
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

export const sessionAuth = createSessionAuth(tokenService);

export function createWorkApp(
  store: MemoryBoardStore,
  resolve: (userId: string) => Promise<AuthContext> = async (userId) => {
    if (userId === userB) {
      return orgBContext();
    }

    return authContext();
  },
  files = new MemoryFileStorage(),
  appOptions: Pick<
    CreateAppOptions,
    'limits' | 'rateLimiter' | 'rateLimitPolicies' | 'trustedProxyIps'
  > = {},
) {
  store.seedOrganizationMember({
    userId: userA,
    organizationId: orgA,
    status: 'active',
    accountStatus: 'active',
    isActive: true,
  });
  store.seedOrganizationMember({
    userId: userC,
    organizationId: orgA,
    status: 'active',
    accountStatus: 'active',
    isActive: true,
  });
  store.seedOrganizationMember({
    userId: userB,
    organizationId: orgB,
    status: 'active',
    accountStatus: 'active',
    isActive: true,
  });

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
    files,
    ...appOptions,
  });
}

export async function json(response: Response) {
  const text = await response.text();
  return text.length === 0
    ? ({} as Record<string, never>)
    : (JSON.parse(text) as Record<string, any>);
}

export async function bearer(userId: string) {
  return (await sessionAuth.issueBearer(userId)).authorization;
}

export function tamperJwt(token: string) {
  const parts = token.split('.');
  const signature = parts[2];
  const tampered = [...signature].map((char) => (char === 'A' ? 'B' : 'A')).join('');
  return `${parts[0]}.${parts[1]}.${tampered}`;
}

export async function createBoard(
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
  return response.board.id as string;
}

export async function createColumn(
  app: ReturnType<typeof createApp>,
  userId: string,
  boardId: string,
  name: string,
) {
  const response = await json(
    await app.request(`/api/boards/${boardId}/columns`, {
      method: 'POST',
      headers: {
        Authorization: await bearer(userId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, statusKey: 'todo' }),
    }),
  );
  return response.column.id as string;
}

export async function createCard(
  app: ReturnType<typeof createApp>,
  userId: string,
  boardId: string,
  columnId: string,
  title = 'Card',
) {
  const response = await json(
    await app.request(`/api/boards/${boardId}/cards`, {
      method: 'POST',
      headers: {
        Authorization: await bearer(userId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, columnId }),
    }),
  );
  return response.card as { id: string; organizationId: string; boardId: string };
}
