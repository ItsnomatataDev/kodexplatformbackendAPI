import { ForbiddenError } from '../http/errors.js';
import type { AuthContext } from './types.js';

export function requireOrganizationId(context: AuthContext): string {
  return context.membership.organizationId;
}

export function assertSameOrganization(
  context: AuthContext,
  resourceOrganizationId: string,
): void {
  if (context.membership.organizationId !== resourceOrganizationId) {
    throw new ForbiddenError(
      'CROSS_ORGANIZATION_ACCESS',
      'Resources cannot be accessed across organizations.',
    );
  }
}

export function rejectClientOrganizationOverride(
  context: AuthContext,
  clientOrganizationId: string | null | undefined,
): void {
  if (
    clientOrganizationId != null &&
    clientOrganizationId !== context.membership.organizationId
  ) {
    throw new ForbiddenError(
      'ORGANIZATION_OVERRIDE_REJECTED',
      'Client-supplied organization_id is not authoritative and does not match the authenticated membership.',
    );
  }
}
