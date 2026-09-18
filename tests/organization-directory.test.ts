import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import type { PublicProfile, PublicProfilePatch } from '../src/auth/public-profile.js';
import type { AuthContext } from '../src/authorization/types.js';
import { ConflictError } from '../src/http/errors.js';
import {
  MemoryOrganizationDirectoryStore,
  seedActiveMember,
} from '../src/organizations/memory-store.js';
import {
  KODE_LEGACY_ROLE_KEYS,
  KODE_OPERATING_ROLE_KEYS,
} from '../src/organizations/role-model.js';
import { createSessionAuth } from './session-auth.js';

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';
const userC = '33333333-3333-3333-3333-333333333333';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const officeA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const officeB = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const inactiveOfficeA = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

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
      officeId: officeA,
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

function orgBAdmin(): AuthContext {
  return authContext({
    actor: { userId: userB, email: 'other@example.com' },
    membership: {
      membershipId: 'membership-2',
      organizationId: orgB,
      officeId: officeB,
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

function emptyProfile(): PublicProfile {
  return {
    fullName: 'Test User',
    avatarUrl: null,
    jobTitle: 'Engineer',
    department: 'Platform',
    employeeCode: 'E-1',
    username: 'test.user',
  };
}

function applyPatch(current: PublicProfile, patch: PublicProfilePatch): PublicProfile {
  return {
    fullName: patch.fullName !== undefined ? patch.fullName : current.fullName,
    avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : current.avatarUrl,
    jobTitle: patch.jobTitle !== undefined ? patch.jobTitle : current.jobTitle,
    department:
      patch.department !== undefined ? patch.department : current.department,
    employeeCode: current.employeeCode,
    username: patch.username !== undefined ? patch.username : current.username,
  };
}

function createDirectoryApp(
  resolve: (userId: string) => Promise<AuthContext>,
  store: MemoryOrganizationDirectoryStore,
  profiles = new Map<string, PublicProfile>([[userA, emptyProfile()]]),
) {
  return createApp({
    auth: {
      verifier: tokenService,
      resolveAuthContext: resolve,
      requireActiveSession: (sessionId, userId) =>
        sessionAuth.requireActiveSession(sessionId, userId),
    },
    me: {
      loadPublicProfile: async (userId) => profiles.get(userId) ?? null,
      updatePublicProfile: async (userId, patch) => {
        const current = profiles.get(userId) ?? {
          fullName: null,
          avatarUrl: null,
          jobTitle: null,
          department: null,
          employeeCode: null,
          username: null,
        };
        const next = applyPatch(current, patch);

        if (next.username) {
          for (const [otherUserId, profile] of profiles) {
            if (otherUserId !== userId && profile.username === next.username) {
              throw new ConflictError(
                'USERNAME_TAKEN',
                'That username is already in use.',
              );
            }
          }
        }

        profiles.set(userId, next);
        return next;
      },
    },
    organizationDirectory: store,
  });
}

function seedDirectory(store: MemoryOrganizationDirectoryStore) {
  store.seedOrganization({
    id: orgA,
    name: 'Org A',
    slug: 'org-a',
    status: 'active',
    accessStatus: 'active',
    isActive: true,
  });
  store.seedOrganization({
    id: orgB,
    name: 'Org B',
    slug: 'org-b',
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
  });
  store.seedOffice({
    id: inactiveOfficeA,
    organizationId: orgA,
    name: 'Closed',
    slug: 'closed',
    isPrimary: false,
    isActive: false,
  });
  store.seedOffice({
    id: officeB,
    organizationId: orgB,
    name: 'Other',
    slug: 'other',
    isPrimary: true,
    isActive: true,
  });

  seedActiveMember(store, {
    organizationId: orgA,
    userId: userA,
    roleKey: 'admin',
    officeId: officeA,
    fullName: 'Ada Admin',
  });
  seedActiveMember(store, {
    organizationId: orgA,
    userId: userC,
    roleKey: 'it',
    officeId: officeA,
    fullName: 'Ivy IT',
  });
  seedActiveMember(store, {
    organizationId: orgB,
    userId: userB,
    roleKey: 'admin',
    officeId: officeB,
    fullName: 'Other Admin',
  });

  for (const roleKey of KODE_OPERATING_ROLE_KEYS) {
    store.seedRole({
      id: `role-a-${roleKey}`,
      organizationId: orgA,
      roleKey,
      roleLabel: roleKey,
      isAdminRole: roleKey === 'admin',
      isManagerRole: roleKey === 'manager',
      isActive: true,
    });
    store.seedRole({
      id: `role-b-${roleKey}`,
      organizationId: orgB,
      roleKey,
      roleLabel: roleKey,
      isAdminRole: roleKey === 'admin',
      isManagerRole: roleKey === 'manager',
      isActive: true,
    });
  }

  store.seedRole({
    id: 'role-a-employee',
    organizationId: orgA,
    roleKey: 'employee',
    roleLabel: 'Employee',
    isAdminRole: false,
    isManagerRole: false,
    isActive: false,
  });
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

async function bearer(userId: string) {
  return (await sessionAuth.issueBearer(userId)).authorization;
}

test('offices migration adds same-org integrity and a safe backfill', () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), 'migrations/0009_organization_offices.sql'),
    'utf8',
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS organizations\.offices/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS office_id UUID/);
  assert.match(sql, /membership_office_same_org/);
  assert.match(sql, /OFFICE BACKFILL SKIPPED/);
  assert.match(sql, /COUNT\(DISTINCT membership\.organization_id\) = 1/);
  assert.match(sql, /ON DELETE SET NULL/);
  assert.match(sql, /'Imported office'/);
  assert.match(sql, /proven\.id::text/);
  assert.doesNotMatch(sql, /employees\.view/);
  assert.doesNotMatch(sql, /work\./);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+identity/i);
  assert.doesNotMatch(sql, /organization_id.*user_profiles/);
});

test('auth context loads office from membership and authorize does not filter by office', () => {
  const resolveSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/auth/resolve-context.ts'),
    'utf8',
  );
  const authorizeSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/authorization/authorize.ts'),
    'utf8',
  );

  assert.match(resolveSource, /organizations\.offices/);
  assert.match(resolveSource, /ofc\.is_active = TRUE/);
  assert.match(resolveSource, /officeId: row\.office_id/);
  assert.doesNotMatch(authorizeSource, /officeId/);
  assert.doesNotMatch(authorizeSource, /offices/);
});

test('GET /api/me exposes membership officeId and ignores profile as authority', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedDirectory(store);
  const app = createDirectoryApp(async () => authContext(), store);

  const body = await json(
    await app.request('/api/me', {
      headers: { Authorization: await bearer(userA) },
    }),
  );

  assert.equal(body.membership.organizationId, orgA);
  assert.equal(body.membership.officeId, officeA);
  assert.equal(body.membership.roleKey, 'admin');
  assert.equal(body.profile.fullName, 'Test User');
});

test('GET organization, offices, and roles are scoped to the membership org', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedDirectory(store);
  const app = createDirectoryApp(async (userId) => {
    if (userId === userB) {
      return orgBAdmin();
    }
    return authContext();
  }, store);

  const organization = await json(
    await app.request('/api/organization', {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(organization.organization.id, orgA);
  assert.equal(organization.organization.slug, 'org-a');
  assert.equal(organization.organization.name, 'Org A');

  const offices = await json(
    await app.request('/api/offices', {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.deepEqual(
    offices.offices.map((office: { id: string }) => office.id).sort(),
    [inactiveOfficeA, officeA].sort(),
  );
  assert.equal(
    offices.offices.some((office: { id: string }) => office.id === officeB),
    false,
  );

  const otherOffice = await json(
    await app.request(`/api/offices/${officeB}`, {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(otherOffice.error?.code, 'OFFICE_NOT_FOUND');

  const roles = await json(
    await app.request('/api/roles', {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.deepEqual(
    roles.roles.map((role: { roleKey: string }) => role.roleKey).sort(),
    [...KODE_OPERATING_ROLE_KEYS].sort(),
  );
  assert.equal(
    roles.roles.some((role: { roleKey: string }) => role.roleKey === 'employee'),
    false,
  );
  assert.equal(
    roles.roles.some((role: { permissions?: unknown }) => 'permissions' in role),
    false,
  );

  for (const key of KODE_LEGACY_ROLE_KEYS) {
    assert.equal(
      roles.roles.some((role: { roleKey: string }) => role.roleKey === key),
      false,
    );
  }
});

test('client organization overrides are rejected on tenancy routes', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedDirectory(store);
  const app = createDirectoryApp(async () => authContext(), store);
  const authorization = await bearer(userA);

  for (const pathName of [
    `/api/organization?organization_id=${orgB}`,
    `/api/organization/members?organization_id=${orgB}`,
    `/api/offices?organization_id=${orgB}`,
    `/api/roles?organization_id=${orgB}`,
    `/api/me?organization_id=${orgB}`,
  ]) {
    const body = await json(
      await app.request(pathName, {
        headers: { Authorization: authorization },
      }),
    );
    assert.equal(body.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');
  }
});

test('member directory is restricted to admin or manager flags', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedDirectory(store);

  const memberApp = createDirectoryApp(
    async () =>
      authContext({
        membership: {
          roleKey: 'it',
          isAdminRole: false,
          isManagerRole: false,
        },
      }),
    store,
  );
  const denied = await json(
    await memberApp.request('/api/organization/members', {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(denied.error?.code, 'INSUFFICIENT_PERMISSION');

  const managerApp = createDirectoryApp(
    async () =>
      authContext({
        membership: {
          roleKey: 'manager',
          isAdminRole: false,
          isManagerRole: true,
        },
      }),
    store,
  );
  const listed = await json(
    await managerApp.request('/api/organization/members', {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.deepEqual(
    listed.members.map((member: { userId: string }) => member.userId).sort(),
    [userA, userC].sort(),
  );
  assert.equal(
    listed.members.some((member: { userId: string }) => member.userId === userB),
    false,
  );
});

test('non-admin office lists hide inactive offices and 404 other-org ids', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedDirectory(store);
  const app = createDirectoryApp(
    async () =>
      authContext({
        membership: {
          roleKey: 'it',
          isAdminRole: false,
          isManagerRole: false,
        },
      }),
    store,
  );
  const authorization = await bearer(userA);

  const offices = await json(
    await app.request('/api/offices', {
      headers: { Authorization: authorization },
    }),
  );
  assert.deepEqual(
    offices.offices.map((office: { id: string }) => office.id),
    [officeA],
  );

  const inactive = await json(
    await app.request(`/api/offices/${inactiveOfficeA}`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(inactive.error?.code, 'OFFICE_NOT_FOUND');
});

test('PATCH /api/me updates person fields and cannot escalate org, office, or role', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedDirectory(store);
  const profiles = new Map<string, PublicProfile>([[userA, emptyProfile()]]);
  const app = createDirectoryApp(async () => authContext(), store, profiles);
  const authorization = await bearer(userA);

  const updated = await json(
    await app.request('/api/me', {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fullName: 'Ada Lovelace',
        jobTitle: 'Mathematician',
        department: 'Analytics',
        username: 'ada',
      }),
    }),
  );
  assert.equal(updated.profile.fullName, 'Ada Lovelace');
  assert.equal(updated.profile.jobTitle, 'Mathematician');
  assert.equal(updated.profile.username, 'ada');
  assert.equal(updated.membership.roleKey, 'admin');
  assert.equal(updated.membership.officeId, officeA);
  assert.equal(updated.membership.organizationId, orgA);

  for (const body of [
    { roleKey: 'admin' },
    { officeId: officeB },
    { organizationId: orgB },
    { accountStatus: 'active' },
    { isAdminRole: true },
  ]) {
    const rejected = await json(
      await app.request('/api/me', {
        method: 'PATCH',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(rejected.error?.code, 'PROFILE_FIELD_REJECTED');
  }

  assert.equal(profiles.get(userA)?.fullName, 'Ada Lovelace');
  assert.equal(updated.user.accountStatus, 'active');
});
