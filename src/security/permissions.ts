import type { AuthContext } from '../authorization/types.js';
import { hasPermission } from '../authorization/permissions.js';
import { ForbiddenError } from '../http/errors.js';
import { isSecurityStaff, requireProductOrg } from '../products/staff.js';

export type SecurityPermission =
  | 'security.view'
  | 'security.investigate'
  | 'security.manage_assets'
  | 'security.manage_rules'
  | 'security.manage_honeypots'
  | 'security.contain'
  | 'security.manage_configuration'
  | 'security.audit'
  | 'security.manage';

/** Broad staff gate (admin / it / security.manage) OR a specific permission. */
export function canSecurity(
  auth: AuthContext,
  permission: SecurityPermission = 'security.view',
) {
  if (isSecurityStaff(auth)) return true;
  return hasPermission(auth.membership.permissions, permission);
}

export function requireSecurityPermission(
  auth: AuthContext,
  permission: SecurityPermission = 'security.view',
) {
  const organizationId = requireProductOrg(auth);
  if (!canSecurity(auth, permission)) {
    throw new ForbiddenError(
      'SECURITY_PERMISSION_REQUIRED',
      `Security permission required: ${permission}`,
    );
  }
  return organizationId;
}
