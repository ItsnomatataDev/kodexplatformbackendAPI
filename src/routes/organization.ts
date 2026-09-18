import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { ForbiddenError, NotFoundError } from '../http/errors.js';
import { rejectTenancyOverrides } from '../organizations/http.js';
import type { OrganizationDirectoryStore } from '../organizations/store.js';

export type OrganizationRouteDependencies = {
  store: OrganizationDirectoryStore;
};

function canListMembers(auth: ReturnType<typeof getAuth>) {
  return auth.membership.isAdminRole || auth.membership.isManagerRole;
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

    if (!canListMembers(auth)) {
      throw new ForbiddenError(
        'INSUFFICIENT_PERMISSION',
        'Only administrators and managers can list organization members.',
      );
    }

    const organizationId = requireOrganizationId(auth);
    const members = await dependencies.store.listMembers(organizationId);

    return c.json({
      members: members.map((member) => ({
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
      })),
    });
  });

  return organization;
}
