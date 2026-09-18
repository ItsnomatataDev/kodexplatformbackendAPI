import type {
  AccountStatus,
  AuthContext,
  MembershipStatus,
  OrganizationAccessStatus,
  OrganizationStatus,
} from '../authorization/types.js';
import { db } from '../db/pool.js';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';

type AuthContextRow = {
  user_id: string;
  email: string | null;
  is_active: boolean;
  account_status: AccountStatus;
  deleted_at: Date | null;
  membership_id: string | null;
  organization_id: string | null;
  office_id: string | null;
  role_id: string | null;
  role_key: string | null;
  membership_status: MembershipStatus | null;
  is_admin_role: boolean | null;
  is_manager_role: boolean | null;
  permissions: unknown;
  organization_is_active: boolean | null;
  organization_status: OrganizationStatus | null;
  organization_access_status: OrganizationAccessStatus | null;
};

export async function resolveAuthContext(
  userId: string,
): Promise<AuthContext> {
  const result = await db.query<AuthContextRow>(
    `
      SELECT
        u.id AS user_id,
        u.email,
        u.is_active,
        u.account_status,
        u.deleted_at,
        m.id AS membership_id,
        m.organization_id,
        ofc.id AS office_id,
        m.role_id,
        m.role_key,
        m.status AS membership_status,
        COALESCE(r.is_admin_role, FALSE) AS is_admin_role,
        COALESCE(r.is_manager_role, FALSE) AS is_manager_role,
        COALESCE(r.permissions, '{}'::jsonb) AS permissions,
        o.is_active AS organization_is_active,
        o.status AS organization_status,
        o.access_status AS organization_access_status
      FROM identity.users u
      LEFT JOIN organizations.memberships m
        ON m.user_id = u.id
       AND m.status = 'active'
      LEFT JOIN organizations.roles r
        ON r.id = m.role_id
      LEFT JOIN organizations.organizations o
        ON o.id = m.organization_id
      LEFT JOIN organizations.offices ofc
        ON ofc.id = m.office_id
       AND ofc.organization_id = m.organization_id
       AND ofc.is_active = TRUE
      WHERE u.id = $1
    `,
    [userId],
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError(
      'IDENTITY_NOT_FOUND',
      'The authenticated identity is no longer valid.',
    );
  }

  if (result.rows.length > 1) {
    throw new ForbiddenError(
      'MULTIPLE_ACTIVE_MEMBERSHIPS',
      'Active organization membership is ambiguous.',
    );
  }

  const row = result.rows[0];

  if (!row.membership_id || !row.organization_id || !row.membership_status) {
    throw new ForbiddenError(
      'NO_ORGANIZATION_MEMBERSHIP',
      'The account has no active organization membership.',
    );
  }

  if (
    row.organization_is_active == null ||
    !row.organization_status ||
    !row.organization_access_status
  ) {
    throw new ForbiddenError(
      'ORGANIZATION_NOT_FOUND',
      'The organization membership is invalid.',
    );
  }

  return {
    actor: {
      userId: row.user_id,
      email: row.email,
      isActive: row.is_active,
      accountStatus: row.account_status,
      deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    },
    membership: {
      membershipId: row.membership_id,
      organizationId: row.organization_id,
      officeId: row.office_id,
      roleId: row.role_id,
      roleKey: row.role_key,
      status: row.membership_status,
      isAdminRole: Boolean(row.is_admin_role),
      isManagerRole: Boolean(row.is_manager_role),
      permissions: row.permissions ?? {},
    },
    organization: {
      organizationId: row.organization_id,
      isActive: Boolean(row.organization_is_active),
      status: row.organization_status,
      accessStatus: row.organization_access_status,
    },
  };
}
