import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import type { AuthContext } from '../authorization/types.js';
import { listOffset } from '../db/list-bounds.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { readListQuery } from '../http/list-query.js';
import { isKodeOperatingRoleKey } from '../organizations/role-model.js';
import { rejectTenancyOverrides } from '../organizations/http.js';
import type { OrganizationDirectoryStore } from '../organizations/store.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';

export type OrganizationRouteDependencies = {
  store: OrganizationDirectoryStore;
};

function canManageDirectory(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it'
  );
}

function requireDirectoryManager(auth: AuthContext) {
  if (!canManageDirectory(auth)) {
    throw new ForbiddenError(
      'INSUFFICIENT_PERMISSION',
      'Only administrators, managers, and IT can manage the organization directory.',
    );
  }
}

function serializeMember(
  member: Awaited<ReturnType<OrganizationDirectoryStore['listMembers']>>['members'][number],
) {
  return {
    userId: member.userId,
    email: member.email,
    fullName: member.fullName,
    avatarUrl: member.avatarUrl,
    jobTitle: member.jobTitle,
    department: member.department,
    username: member.username,
    employeeCode: member.employeeCode,
    roleKey: member.roleKey,
    officeId: member.officeId,
    status: member.status,
    accountStatus: member.accountStatus,
  };
}

function readOperatingRoleKey(value: unknown, field = 'roleKey'): string {
  const roleKey = readRequiredText(value, field, 64).trim().toLowerCase();
  if (!isKodeOperatingRoleKey(roleKey)) {
    throw new ValidationError('The selected role is not available.', {
      field,
    });
  }
  return roleKey;
}

export function createOrganizationRoutes(
  dependencies: OrganizationRouteDependencies,
) {
  const organization = new Hono();

  organization.get('/', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);

    const organizationId = requireOrganizationId(auth);
    const record = await dependencies.store.getOrganization(organizationId);

    if (!record) {
      throw new NotFoundError(
        'ORGANIZATION_NOT_FOUND',
        'The organization was not found.',
      );
    }

    return c.json({
      organization: {
        id: record.id,
        name: record.name,
        slug: record.slug,
        status: record.status,
        accessStatus: record.accessStatus,
        isActive: record.isActive,
      },
    });
  });

  organization.get('/members', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);
    requireDirectoryManager(auth);

    const organizationId = requireOrganizationId(auth);
    const page = readListQuery(c);
    const members = await dependencies.store.listMembers(organizationId, {
      statuses: ['active', 'pending'],
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    });

    return c.json({
      members: members.members.map(serializeMember),
      hasMore: members.hasMore,
    });
  });

  organization.post('/members/invite', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectTenancyOverrides(auth, c, body);
    requireDirectoryManager(auth);

    const organizationId = requireOrganizationId(auth);
    const email = readRequiredText(body.email, 'email', 320);
    const fullName =
      readOptionalString(body.fullName ?? body.full_name, 'fullName', 200) ?? '';
    const roleKey = readOperatingRoleKey(body.roleKey ?? body.role);
    const officeRaw = body.officeId ?? body.office_id;
    const officeId =
      officeRaw === undefined || officeRaw === null
        ? null
        : requireUuidValue(officeRaw, 'officeId');

    const result = await dependencies.store.inviteMember({
      organizationId,
      email,
      fullName,
      roleKey,
      invitedBy: auth.actor.userId,
      officeId,
    });

    return c.json(result, 201);
  });

  organization.post('/members/:userId/approve', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectTenancyOverrides(auth, c, body);
    requireDirectoryManager(auth);

    const organizationId = requireOrganizationId(auth);
    const userId = requireUuidValue(c.req.param('userId'), 'userId');
    if (userId === auth.actor.userId) {
      throw new ForbiddenError(
        'CANNOT_MODIFY_SELF',
        'You cannot approve your own account.',
      );
    }

    const roleKey = readOperatingRoleKey(body.roleKey ?? body.role);
    const officeRaw = body.officeId ?? body.office_id;
    const officeId =
      officeRaw === undefined
        ? undefined
        : officeRaw === null
          ? null
          : requireUuidValue(officeRaw, 'officeId');

    const member = await dependencies.store.approveMember({
      organizationId,
      userId,
      roleKey,
      approvedBy: auth.actor.userId,
      officeId,
    });

    return c.json({ member: serializeMember(member) });
  });

  organization.post('/members/:userId/reject', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectTenancyOverrides(auth, c, body);
    requireDirectoryManager(auth);

    const organizationId = requireOrganizationId(auth);
    const userId = requireUuidValue(c.req.param('userId'), 'userId');
    if (userId === auth.actor.userId) {
      throw new ForbiddenError(
        'CANNOT_MODIFY_SELF',
        'You cannot reject your own account.',
      );
    }

    const reason =
      readOptionalString(body.reason ?? body.rejectionReason, 'reason', 2_000) ??
      null;

    const member = await dependencies.store.rejectMember({
      organizationId,
      userId,
      rejectedBy: auth.actor.userId,
      reason,
    });

    return c.json({ member: serializeMember(member) });
  });

  organization.patch('/members/:userId/access', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectTenancyOverrides(auth, c, body);
    requireDirectoryManager(auth);

    const organizationId = requireOrganizationId(auth);
    const userId = requireUuidValue(c.req.param('userId'), 'userId');
    if (userId === auth.actor.userId) {
      throw new ForbiddenError(
        'CANNOT_MODIFY_SELF',
        'You cannot change your own directory access.',
      );
    }

    const roleKey = readOperatingRoleKey(body.roleKey ?? body.role);
    const changeOffice =
      body.changeOffice === undefined && body.change_office === undefined
        ? body.officeId !== undefined || body.office_id !== undefined
        : Boolean(body.changeOffice ?? body.change_office);
    const officeRaw = body.officeId ?? body.office_id;
    const officeId =
      officeRaw === undefined
        ? null
        : officeRaw === null
          ? null
          : requireUuidValue(officeRaw, 'officeId');

    const member = await dependencies.store.updateMemberAccess({
      organizationId,
      userId,
      roleKey,
      officeId,
      changeOffice,
    });

    return c.json({ member: serializeMember(member) });
  });

  organization.get('/assignable-users', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);

    const organizationId = requireOrganizationId(auth);
    assertAuthorized({
      context: auth,
      action: 'work.cards.read',
      resource: {
        type: 'work.card',
        organizationId,
      },
    });

    const page = readListQuery(c);
    const members = await dependencies.store.listMembers(organizationId, {
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    });
    return c.json({
      members: members.members.map(serializeMember),
      hasMore: members.hasMore,
    });
  });

  return organization;
}
