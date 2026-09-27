import type { AuthContext } from '../authorization/types.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';

export function isAdminManagerIt(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it'
  );
}

export function isSecurityStaff(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.roleKey === 'it' ||
    hasPermission(auth.membership.permissions, 'security.manage')
  );
}

export function isTourismStaff(auth: AuthContext) {
  const role = auth.membership.roleKey ?? '';
  return (
    isAdminManagerIt(auth) ||
    [
      'tourism_operations_manager',
      'reservations_agent',
      'guest_relations',
      'activity_coordinator',
      'fleet_coordinator',
    ].includes(role)
  );
}

export function isMediaStaff(auth: AuthContext) {
  const role = auth.membership.roleKey ?? '';
  return (
    isAdminManagerIt(auth) ||
    [
      'media',
      'content',
      'content_strategist',
      'social_media',
      'designer',
      'copywriter',
    ].includes(role) ||
    hasPermission(auth.membership.permissions, 'social.manage')
  );
}

export function isLocationPlannerStaff(auth: AuthContext) {
  return isAdminManagerIt(auth);
}

/** Active org membership is enough for product access (mutations still staff-gated). */
export function requireProductOrg(auth: AuthContext) {
  return requireOrganizationId(auth);
}

export function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function dateOnly(value: Date | string | null | undefined) {
  if (!value) return null;
  return String(value).slice(0, 10);
}
