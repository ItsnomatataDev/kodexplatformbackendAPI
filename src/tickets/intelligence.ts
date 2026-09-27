import type { AuthContext } from '../authorization/types.js';

/** Matches frontend canSeeInmTicketIntelligence — ITs No Matata IT/admin only. */
export const INM_TICKET_INTELLIGENCE_ROLES = new Set([
  'it',
  'admin',
  'org_admin',
  'super_admin',
  'superadmin',
  'it-superadmin',
]);

export const INM_OFFICE_SLUG = 'its-no-matata';

/** Roles that may trigger the monthly IT ticket report. */
export const MONTHLY_REPORT_TRIGGER_ROLES = new Set([
  'admin',
  'org_admin',
  'super_admin',
  'it',
]);

/** Admin recipients for the monthly IT ticket report email. */
export const MONTHLY_REPORT_ADMIN_ROLES = new Set([
  'admin',
  'org_admin',
  'super_admin',
]);

export function isInmTicketIntelligenceAllowed(params: {
  officeSlug: string | null | undefined;
  roleKey: string | null | undefined;
  isAdminRole?: boolean;
}) {
  const slug = String(params.officeSlug ?? '')
    .trim()
    .toLowerCase();
  if (slug !== INM_OFFICE_SLUG) {
    return false;
  }
  const role = String(params.roleKey ?? '')
    .trim()
    .toLowerCase();
  if (INM_TICKET_INTELLIGENCE_ROLES.has(role)) {
    return true;
  }
  return Boolean(params.isAdminRole);
}

export function canSeeTicketWorkIntelligence(
  auth: AuthContext,
  officeSlug: string | null | undefined,
) {
  return isInmTicketIntelligenceAllowed({
    officeSlug,
    roleKey: auth.membership.roleKey,
    isAdminRole: auth.membership.isAdminRole,
  });
}

export function canTriggerMonthlyTicketReport(auth: AuthContext) {
  const role = String(auth.membership.roleKey ?? '')
    .trim()
    .toLowerCase();
  return (
    auth.membership.isAdminRole ||
    auth.membership.roleKey === 'it' ||
    MONTHLY_REPORT_TRIGGER_ROLES.has(role)
  );
}

export function estimateConfidence(
  sampleCount: number,
): 'none' | 'low' | 'medium' | 'high' {
  if (sampleCount >= 8) return 'high';
  if (sampleCount >= 3) return 'medium';
  if (sampleCount >= 1) return 'low';
  return 'none';
}

export function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}
