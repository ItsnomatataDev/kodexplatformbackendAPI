import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import type {
  PublicProfile,
  PublicProfilePatch,
} from '../auth/public-profile.js';
import {
  readPublicProfilePatch,
  rejectedProfileFields,
} from '../auth/public-profile.js';
import { ForbiddenError } from '../http/errors.js';
import { rejectTenancyOverrides, readJsonBody } from '../organizations/http.js';

export type MeRouteDependencies = {
  loadPublicProfile: (userId: string) => Promise<PublicProfile | null>;
  updatePublicProfile?: (
    userId: string,
    patch: PublicProfilePatch,
  ) => Promise<PublicProfile>;
};

function serializeMe(
  auth: ReturnType<typeof getAuth>,
  profile: PublicProfile | null,
) {
  return {
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
      officeId: auth.membership.officeId ?? null,
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
  };
}

export function createMeRoutes(dependencies: MeRouteDependencies) {
  const me = new Hono();

  me.get('/', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);

    const profile = await dependencies.loadPublicProfile(auth.actor.userId);

    return c.json(serializeMe(auth, profile));
  });

  me.patch('/', async (c) => {
    const auth = getAuth(c);
    const body = await readJsonBody(c);

    const rejected = rejectedProfileFields(body);
    if (rejected.length > 0) {
      throw new ForbiddenError(
        'PROFILE_FIELD_REJECTED',
        'Profile updates cannot change organization, office, role, or account status.',
      );
    }

    rejectTenancyOverrides(auth, c, body);

    const patch = readPublicProfilePatch(body);
    const updater = dependencies.updatePublicProfile;

    const profile = updater
      ? await updater(auth.actor.userId, patch)
      : await dependencies.loadPublicProfile(auth.actor.userId);

    return c.json(serializeMe(auth, profile));
  });

  return me;
}
