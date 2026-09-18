import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertAuthorized,
  authorize,
  rejectClientOrganizationOverride,
  requireOrganizationId,
} from '../src/authorization/index.js';
import { hasPermission } from '../src/authorization/permissions.js';
import type { AuthContext } from '../src/authorization/types.js';
import { ForbiddenError, UnauthorizedError } from '../src/http/errors.js';

const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const userA = '11111111-1111-1111-1111-111111111111';

function context(
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
      roleKey: 'member',
      status: 'active',
      isAdminRole: false,
      isManagerRole: false,
      permissions: { 'work.cards.read': true },
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

test('hasPermission supports flat, nested, wildcard, and list grants', () => {
  assert.equal(hasPermission({ 'work.cards.read': true }, 'work.cards.read'), true);
  assert.equal(hasPermission({ work: { cards: { read: true } } }, 'work.cards.read'), true);
  assert.equal(hasPermission({ work: { '*': true } }, 'work.cards.update'), true);
  assert.equal(hasPermission(['work.cards.read', '*'], 'work.cards.delete'), true);
  assert.equal(hasPermission({ 'work.cards.read': true }, 'work.cards.update'), false);
  assert.equal(hasPermission({}, 'work.cards.read'), false);
});

test('unauthenticated requests are denied', () => {
  const decision = authorize({
    context: null,
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgA },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'UNAUTHENTICATED');
  assert.throws(
    () =>
      assertAuthorized({
        context: null,
        action: 'work.cards.read',
        resource: { type: 'work.card', organizationId: orgA },
      }),
    UnauthorizedError,
  );
});

test('suspended and inactive accounts cannot access organization resources', () => {
  const suspended = authorize({
    context: context({ actor: { accountStatus: 'suspended' } }),
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgA },
  });
  const pending = authorize({
    context: context({ actor: { accountStatus: 'pending_approval' } }),
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgA },
  });
  const inactive = authorize({
    context: context({ actor: { isActive: false } }),
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgA },
  });

  assert.equal(suspended.code, 'ACCOUNT_SUSPENDED');
  assert.equal(pending.code, 'ACCOUNT_NOT_ACTIVE');
  assert.equal(inactive.code, 'ACCOUNT_INACTIVE');
});

test('inactive memberships and organizations are denied', () => {
  const membership = authorize({
    context: context({ membership: { status: 'removed' } }),
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgA },
  });
  const organization = authorize({
    context: context({
      organization: { status: 'suspended', isActive: false },
    }),
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgA },
  });

  assert.equal(membership.code, 'MEMBERSHIP_INACTIVE');
  assert.equal(organization.code, 'ORGANIZATION_INACTIVE');
});

test('cross-organization access is denied even for admins', () => {
  const decision = authorize({
    context: context({
      membership: { isAdminRole: true, permissions: {} },
    }),
    action: 'work.cards.read',
    resource: {
      type: 'work.card',
      id: 'card-1',
      organizationId: orgB,
    },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'CROSS_ORGANIZATION_ACCESS');
});

test('client-supplied organization_id cannot override membership', () => {
  const auth = context();

  assert.equal(requireOrganizationId(auth), orgA);
  assert.doesNotThrow(() => rejectClientOrganizationOverride(auth, orgA));
  assert.doesNotThrow(() => rejectClientOrganizationOverride(auth, null));
  assert.throws(
    () => rejectClientOrganizationOverride(auth, orgB),
    (error: unknown) =>
      error instanceof ForbiddenError &&
      error.code === 'ORGANIZATION_OVERRIDE_REJECTED',
  );
});

test('permissions fail closed and admins are scoped to their organization', () => {
  const denied = authorize({
    context: context({ membership: { permissions: {} } }),
    action: 'work.cards.update',
    resource: { type: 'work.card', organizationId: orgA },
  });
  const allowed = authorize({
    context: context(),
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgA },
  });
  const admin = authorize({
    context: context({
      membership: { isAdminRole: true, permissions: {} },
    }),
    action: 'work.cards.delete',
    resource: { type: 'work.card', organizationId: orgA },
  });

  assert.equal(denied.code, 'INSUFFICIENT_PERMISSION');
  assert.equal(allowed.allowed, true);
  assert.equal(admin.allowed, true);
});

test('ownership checks only apply when requested', () => {
  const otherOwner = authorize({
    context: context(),
    action: 'work.cards.read',
    resource: {
      type: 'work.card',
      organizationId: orgA,
      ownerId: '99999999-9999-9999-9999-999999999999',
    },
    requireOwnership: true,
  });
  const sameOwner = authorize({
    context: context(),
    action: 'work.cards.read',
    resource: {
      type: 'work.card',
      organizationId: orgA,
      ownerId: userA,
    },
    requireOwnership: true,
  });

  assert.equal(otherOwner.code, 'NOT_OWNER');
  assert.equal(sameOwner.allowed, true);
});

test('authorize stays organization-scoped when membership officeId is set', () => {
  const officeId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const allowed = authorize({
    context: context({ membership: { officeId } }),
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgA },
  });
  const crossOrg = authorize({
    context: context({ membership: { officeId } }),
    action: 'work.cards.read',
    resource: { type: 'work.card', organizationId: orgB },
  });

  assert.equal(allowed.allowed, true);
  assert.equal(crossOrg.code, 'CROSS_ORGANIZATION_ACCESS');
});
