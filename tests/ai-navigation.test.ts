import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthContext } from '../src/authorization/types.js';
import { resolveWorkspaceNavigation, type NavigationSource } from '../src/ai/navigation.js';

const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';
const acmeId = '22222222-2222-4222-8222-222222222222';
const boardId = '33333333-3333-4333-8333-333333333333';

function auth(partial: {
  roleKey?: string;
  isAdminRole?: boolean;
  permissions?: Record<string, unknown>;
} = {}): AuthContext {
  return {
    actor: {
      userId,
      email: 'person@example.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId: org,
      officeId: null,
      roleId: 'role-1',
      roleKey: partial.roleKey ?? 'media_team',
      status: 'active',
      isAdminRole: partial.isAdminRole ?? false,
      isManagerRole: false,
      permissions: partial.permissions ?? {
        work: { boards: { read: true }, cards: { read: true }, time_entries: { read: true } },
        leave: { read: true },
        attendance: { read: true },
        chat: { read: true },
        tickets: { read: true },
        content_studio: { read: true },
        media: { read: true },
        duty_roster: { read: true },
      },
    },
    organization: {
      organizationId: org,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

function source(options: {
  clients?: Array<{ id: string; name: string }>;
  boards?: Array<{ id: string; name: string }>;
} = {}): NavigationSource {
  return {
    async findContentClients() {
      return options.clients ?? [];
    },
    async findBoards() {
      return options.boards ?? [];
    },
  };
}

test('a timer command is not treated as navigation', async () => {
  const result = await resolveWorkspaceNavigation(
    auth(),
    'start my timer on Homepage',
    source(),
  );
  assert.equal(result, null);
});

test('open content studio goes to the clients page', async () => {
  const result = await resolveWorkspaceNavigation(auth(), 'kodex open the content studio window', source());
  assert.equal(result?.navigation?.path, '/content-studio/clients');
  assert.match(result?.reply ?? '', /Opening Content Studio/);
});

test('open a named content studio client', async () => {
  const result = await resolveWorkspaceNavigation(
    auth(),
    'open content studio and open Acme Media',
    source({ clients: [{ id: acmeId, name: 'Acme Media' }] }),
  );
  assert.equal(result?.navigation?.path, `/content-studio/clients/${acmeId}`);
});

test('a role without content studio cannot open it', async () => {
  const result = await resolveWorkspaceNavigation(
    auth({ roleKey: 'seo_specialist', permissions: { work: { boards: { read: true } } } }),
    'open content studio',
    source({ clients: [{ id: acmeId, name: 'Secret Client' }] }),
  );
  assert.equal(result?.navigation, null);
  assert.match(result?.reply ?? '', /cannot open Content Studio/);
});

test('open leave and a named board', async () => {
  const leave = await resolveWorkspaceNavigation(auth(), 'take me to leave', source());
  assert.equal(leave?.navigation?.path, '/leave');
  const board = await resolveWorkspaceNavigation(
    auth(),
    'open the Web board',
    source({ boards: [{ id: boardId, name: 'Web' }] }),
  );
  assert.equal(board?.navigation?.path, `/boards/${boardId}`);
});

test('two matches and an unknown page do not navigate', async () => {
  const many = await resolveWorkspaceNavigation(
    auth(),
    'open content studio Acme',
    source({
      clients: [
        { id: acmeId, name: 'Acme Media' },
        { id: boardId, name: 'Acme Studio' },
      ],
    }),
  );
  assert.equal(many?.navigation, null);
  assert.match(many?.reply ?? '', /More than one match/);
  const unknown = await resolveWorkspaceNavigation(auth(), 'open the payroll vault', source());
  assert.equal(unknown?.navigation, null);
  assert.match(unknown?.reply ?? '', /Nothing was opened/);
});

test('an external link is not an in-app route', async () => {
  const result = await resolveWorkspaceNavigation(auth(), 'open https://example.com', source());
  assert.equal(result, null);
});
