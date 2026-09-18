import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { rejectTenancyOverrides } from '../organizations/http.js';
import type { OrganizationDirectoryStore } from '../organizations/store.js';

export type RoleRouteDependencies = {
  store: OrganizationDirectoryStore;
};

export function createRoleRoutes(dependencies: RoleRouteDependencies) {
  const roles = new Hono();

  roles.get('/', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);

    const organizationId = requireOrganizationId(auth);
    const records = await dependencies.store.listOperatingRoles(organizationId);

    return c.json({
      roles: records.map((role) => ({
        id: role.id,
        roleKey: role.roleKey,
        roleLabel: role.roleLabel,
        isAdminRole: role.isAdminRole,
        isManagerRole: role.isManagerRole,
      })),
    });
  });

  return roles;
}
