import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { isUuid } from '../auth/uuid.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { rejectTenancyOverrides } from '../organizations/http.js';
import type { OrganizationDirectoryStore } from '../organizations/store.js';

export type OfficeRouteDependencies = {
  store: OrganizationDirectoryStore;
};

function requireOfficeId(officeId: string | undefined): string {
  if (!officeId || !isUuid(officeId)) {
    throw new ValidationError('officeId must be a UUID.', { field: 'officeId' });
  }

  return officeId;
}

export function createOfficeRoutes(dependencies: OfficeRouteDependencies) {
  const offices = new Hono();

  offices.get('/', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);

    const organizationId = requireOrganizationId(auth);
    const records = await dependencies.store.listOffices(organizationId, {
      includeInactive: auth.membership.isAdminRole,
    });

    return c.json({
      offices: records.map((office) => ({
        id: office.id,
        organizationId: office.organizationId,
        name: office.name,
        slug: office.slug,
        isPrimary: office.isPrimary,
        isActive: office.isActive,
      })),
    });
  });

  offices.get('/:officeId', async (c) => {
    const auth = getAuth(c);
    rejectTenancyOverrides(auth, c);

    const organizationId = requireOrganizationId(auth);
    const officeId = requireOfficeId(c.req.param('officeId'));
    const office = await dependencies.store.getOffice(organizationId, officeId);

    if (!office || (!office.isActive && !auth.membership.isAdminRole)) {
      throw new NotFoundError('OFFICE_NOT_FOUND', 'The office was not found.');
    }

    return c.json({
      office: {
        id: office.id,
        organizationId: office.organizationId,
        name: office.name,
        slug: office.slug,
        isPrimary: office.isPrimary,
        isActive: office.isActive,
      },
    });
  });

  return offices;
}
