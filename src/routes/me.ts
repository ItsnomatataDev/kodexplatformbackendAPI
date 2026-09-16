import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { rejectClientUserOverride } from '../auth/account.js';
import type { PublicProfile } from '../auth/public-profile.js';
import { rejectClientOrganizationOverride } from '../authorization/organization.js';

export type MeRouteDependencies = {
  loadPublicProfile: (userId: string) => Promise<PublicProfile | null>;
};

export function createMeRoutes(dependencies: MeRouteDependencies) {
  const me = new Hono();

  me.get('/', async (c) => {
    const auth = getAuth(c);

    rejectClientUserOverride(
      auth,
      c.req.query('user_id') ?? c.req.header('x-user-id'),
    );
    rejectClientOrganizationOverride(
      auth,
      c.req.query('organization_id') ?? c.req.header('x-organization-id'),
    );

    const profile = await dependencies.loadPublicProfile(auth.actor.userId);

    return c.json({
      user: {
        id: auth.actor.userId,
        email: auth.actor.email,
        accountStatus: auth.actor.accountStatus,
        isActive: auth.actor.isActive,
      },
      profile: profile
        ? {
            fullName: profile.fullName,
            avatarUrl: profile.avatarUrl,
            jobTitle: profile.jobTitle,
            department: profile.department,
            employeeCode: profile.employeeCode,
            username: profile.username,
          }
        : null,
      membership: {
        organizationId: auth.membership.organizationId,
        roleKey: auth.membership.roleKey,
        status: auth.membership.status,
        isAdminRole: auth.membership.isAdminRole,
        isManagerRole: auth.membership.isManagerRole,
      },
      organization: {
        id: auth.organization.organizationId,
        status: auth.organization.status,
        accessStatus: auth.organization.accessStatus,
        isActive: auth.organization.isActive,
      },
    });
  });

  return me;
}
