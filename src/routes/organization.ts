import { Hono, type Context } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import type { AuthContext } from '../authorization/types.js';
import { listOffset } from '../db/list-bounds.js';
import { ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from '../http/errors.js';
import type { FileStorage } from '../files/storage.js';
import { streamStoredMedia } from '../content/media-stream.js';
import { readListQuery } from '../http/list-query.js';
import { isKodeOperatingRoleKey, pickDirectoryRoleKey } from '../organizations/role-model.js';
import { rejectTenancyOverrides } from '../organizations/http.js';
import type { OrganizationDirectoryStore } from '../organizations/store.js';
import { PROFILE_PICTURES_BUCKET } from '../organizations/buckets.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';

export type OrganizationRouteDependencies = {
  store: OrganizationDirectoryStore;
  sendInvitation: (email: string, organizationName: string) => Promise<void>;
  files: FileStorage;
  onUserAccessRevoked?: (userId: string) => Promise<void>;
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

  organization.get('/avatar/file', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const objectKey = c.req.query('objectKey');
    const separator = objectKey?.indexOf('/') ?? -1;
    if (!objectKey || separator < 1) {
      throw new ValidationError('objectKey is invalid.', { field: 'objectKey' });
    }

    const userId = requireUuidValue(objectKey.slice(0, separator), 'objectKey');
    const keyParts = objectKey.split('/');
    if (
      keyParts.length < 2 ||
      keyParts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.includes('\\'),
      )
    ) {
      throw new ValidationError('objectKey is invalid.', { field: 'objectKey' });
    }

    const member = await dependencies.store.getMember(organizationId, userId);
    if (
      !member ||
      member.status !== 'active' ||
      member.accountStatus !== 'active'
    ) {
      throw new NotFoundError('AVATAR_NOT_FOUND', 'Avatar was not found.');
    }

    return streamStoredMedia({
      files: dependencies.files,
      bucket: PROFILE_PICTURES_BUCKET,
      objectKey,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, max-age=3600',
      notFoundCode: 'AVATAR_NOT_FOUND',
      notFoundMessage: 'Avatar was not found.',
    });
  });

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
      statuses: c.req.query('includeInactive') === 'true'
        ? ['active', 'pending', 'suspended', 'removed']
        : ['active', 'pending'],
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
    const email = readRequiredText(body.email, 'email', 320).trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) {
      throw new ValidationError('Enter a valid email address.', { field: 'email' });
    }
    const fullName =
      readOptionalString(body.fullName ?? body.full_name, 'fullName', 200) ?? '';
    const requestedRole = readOptionalString(body.roleKey ?? body.role, 'roleKey', 64) ?? '';
    const operatingRoles = await dependencies.store.listOperatingRoles(organizationId);
    const roleKey = pickDirectoryRoleKey(operatingRoles, requestedRole, { allowAdmin: true });
    if (!roleKey) {
      throw new ValidationError('The selected role is not available.', { field: 'roleKey' });
    }
    const officeRaw = body.officeId ?? body.office_id;
    const officeId =
      officeRaw === undefined || officeRaw === null
        ? null
        : requireUuidValue(officeRaw, 'officeId');

    const record = await dependencies.store.getOrganization(organizationId);
    if (!record) throw new NotFoundError('ORGANIZATION_NOT_FOUND', 'The organization was not found.');

    const result = await dependencies.store.inviteMember({
      organizationId,
      email,
      fullName,
      roleKey,
      invitedBy: auth.actor.userId,
      officeId,
    });

    try {
      await dependencies.sendInvitation(email, record.name);
    } catch {
      throw new ServiceUnavailableError(
        'INVITATION_EMAIL_FAILED',
        'The account was saved, but the invitation email could not be sent. Please retry the invitation.',
      );
    }
    return c.json({
      ...result,
      emailStatus: 'sent',
      message: result.status === 'invite_created'
        ? 'Invitation email sent. Account approval is still required.'
        : 'User linked successfully. An email with workspace access instructions has been sent.',
    }, 201);
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
    await dependencies.onUserAccessRevoked?.(userId);

    return c.json({ member: serializeMember(member) });
  });

  async function runAccountAction(
    c: Context,
    action: 'suspend' | 'restore' | 'softDelete' | 'hardDelete',
    selfMessage: string,
  ) {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectTenancyOverrides(auth, c, body);
    requireDirectoryManager(auth);
    const organizationId = requireOrganizationId(auth);
    const userId = requireUuidValue(c.req.param('userId'), 'userId');
    if (userId === auth.actor.userId) {
      throw new ForbiddenError('CANNOT_MODIFY_SELF', selfMessage);
    }
    const reason = readOptionalString(body.reason, 'reason', 2_000) ?? null;
    const input = {
      organizationId,
      userId,
      actorUserId: auth.actor.userId,
      reason,
    };
    const member =
      action === 'suspend'
        ? await dependencies.store.suspendMember(input)
        : action === 'restore'
          ? await dependencies.store.restoreMember(input)
          : action === 'softDelete'
            ? await dependencies.store.softDeleteMember(input)
            : await dependencies.store.hardDeleteMember(input);
    if (action !== 'restore') {
      await dependencies.onUserAccessRevoked?.(userId);
    }
    return c.json({ member: serializeMember(member), action });
  }

  organization.post('/members/:userId/suspend', (c) =>
    runAccountAction(c, 'suspend', 'You cannot suspend your own account.'),
  );
  organization.post('/members/:userId/restore', (c) =>
    runAccountAction(c, 'restore', 'You cannot restore your own account.'),
  );
  organization.post('/members/:userId/delete', (c) =>
    runAccountAction(
      c,
      'softDelete',
      'You cannot delete your own account.',
    ),
  );
  organization.post('/members/:userId/hard-delete', (c) =>
    runAccountAction(
      c,
      'hardDelete',
      'You cannot permanently delete your own account.',
    ),
  );

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
