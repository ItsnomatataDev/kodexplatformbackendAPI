import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import type { AuthContext } from '../src/authorization/types.js';
import {
  MemoryOrganizationDirectoryStore,
  seedActiveMember,
} from '../src/organizations/memory-store.js';
import { KODE_OPERATING_ROLE_KEYS } from '../src/organizations/role-model.js';
import { createSessionAuth } from './session-auth.js';

const userA = '11111111-1111-1111-1111-111111111111';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const officeA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const tokenService = new AccessTokenService({
  secret: 'test-only-access-token-secret-value!!',
  issuer: 'kode-platform/test',
  audience: 'kode-platform-api/test',
  ttlSeconds: 900,
  clockToleranceSeconds: 0,
});
const sessionAuth = createSessionAuth(tokenService);

function authContext(): AuthContext {
  return {
    actor: {
      userId: userA,
      email: 'admin@example.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId: orgA,
      officeId: officeA,
      roleId: 'role-1',
      roleKey: 'admin',
      status: 'active',
      isAdminRole: true,
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

function seedOrg(store: MemoryOrganizationDirectoryStore) {
  store.seedOrganization({
    id: orgA,
    name: 'Org A',
    slug: 'org-a',
    status: 'active',
    accessStatus: 'active',
    isActive: true,
  });
  store.seedOffice({
    id: officeA,
    organizationId: orgA,
    name: 'Harare',
    slug: 'harare',
    isPrimary: true,
    isActive: true,
    settings: {},
  });
  seedActiveMember(store, {
    organizationId: orgA,
    userId: userA,
    roleKey: 'admin',
    officeId: officeA,
    fullName: 'Ada Admin',
    email: 'admin@example.com',
  });
  for (const roleKey of KODE_OPERATING_ROLE_KEYS) {
    store.seedRole({
      id: `role-${roleKey}`,
      organizationId: orgA,
      roleKey,
      roleLabel: roleKey,
      isAdminRole: roleKey === 'admin',
      isManagerRole: roleKey === 'manager',
      isActive: true,
      isDefaultSignupRole: roleKey === 'media_team',
    });
  }
}

function createSignupApp(store: MemoryOrganizationDirectoryStore) {
  return createApp({
    organizationDirectory: store,
    auth: {
      verifier: tokenService,
      resolveAuthContext: async () => authContext(),
      requireActiveSession: (sessionId, userId) =>
        sessionAuth.requireActiveSession(sessionId, userId),
    },
    me: { loadPublicProfile: async () => null },
  });
}

test('signup options expose public roles and offices for an organization slug', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedOrg(store);
  const app = createSignupApp(store);
  const response = await app.request('/auth/signup/options?organization_slug=org-a');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.organization.slug, 'org-a');
  assert.equal(body.roles.some((role: { roleKey: string }) => role.roleKey === 'admin'), false);
  assert.equal(body.roles.find((role: { isDefaultSignupRole: boolean }) => role.isDefaultSignupRole)?.roleKey, 'media_team');
  assert.equal(body.offices[0].slug, 'harare');
});

test('signup creates a pending account and does not issue a session', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedOrg(store);
  const app = createSignupApp(store);
  const response = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: ' New.Person@example.com ',
      password: 'correct-horse',
      fullName: 'New Person',
      organizationSlug: 'org-a',
      role: 'admin',
      officeSlug: 'harare',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.approvalRequired, true);
  assert.equal(body.user.email, 'new.person@example.com');
  assert.equal(body.membership.roleKey, 'media_team');
  assert.equal(body.access_token, undefined);
  const created = await store.findUserByEmail('new.person@example.com');
  assert.equal(created?.accountStatus, 'pending_approval');
  const member = await store.getMember(orgA, created!.userId);
  assert.equal(member?.status, 'pending');
  assert.equal(member?.officeId, officeA);
});

test('signup rejects duplicate emails and unknown organizations', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedOrg(store);
  const app = createSignupApp(store);
  const missing = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'person@example.com',
      password: 'correct-horse',
      fullName: 'Person',
      organizationSlug: 'missing-org',
    }),
  });
  assert.equal(missing.status, 404);
  const first = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'person@example.com',
      password: 'correct-horse',
      fullName: 'Person',
      organizationSlug: 'org-a',
    }),
  });
  assert.equal(first.status, 201);
  const duplicate = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'person@example.com',
      password: 'correct-horse',
      fullName: 'Person',
      organizationSlug: 'org-a',
    }),
  });
  const body = await duplicate.json();
  assert.equal(duplicate.status, 409);
  assert.equal(body.error.code, 'ACCOUNT_EXISTS');
});
