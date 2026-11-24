import type { AuthContext } from '../authorization/types.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';

export function assignedContentStudioOfficeId(auth: AuthContext): string | null {
  if (auth.membership.isAdminRole) {
    return null;
  }
  if (!auth.membership.officeId) {
    throw new ForbiddenError(
      'CONTENT_STUDIO_OFFICE_UNASSIGNED',
      'Your account is not assigned to a Content Studio office. Ask an organization administrator to assign one.',
    );
  }
  return auth.membership.officeId;
}

export function assertContentStudioOfficeAccess(
  auth: AuthContext,
  officeId: string,
) {
  const assignedOfficeId = assignedContentStudioOfficeId(auth);
  if (assignedOfficeId && officeId !== assignedOfficeId) {
    throw new ForbiddenError(
      'CONTENT_STUDIO_OFFICE_FORBIDDEN',
      'Your account is not authorized to access this Content Studio office.',
    );
  }
}

export function requireContentStudioOfficeId(
  auth: AuthContext,
  requestedOfficeId?: string | null,
) {
  const assignedOfficeId = assignedContentStudioOfficeId(auth);
  const officeId = (requestedOfficeId ?? assignedOfficeId ?? '').trim();
  if (!officeId) {
    throw new ValidationError(
      'An officeId is required for Content Studio access.',
      { field: 'officeId' },
    );
  }
  if (assignedOfficeId && officeId !== assignedOfficeId) {
    throw new ForbiddenError(
      'CONTENT_STUDIO_OFFICE_FORBIDDEN',
      'Your account is not authorized to access this Content Studio office.',
    );
  }
  return officeId;
}
