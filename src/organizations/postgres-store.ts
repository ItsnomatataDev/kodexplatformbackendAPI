import { randomUUID } from 'node:crypto';
import { normalizeEmail } from '../auth/login.js';
import type { AccountStatus, MembershipStatus } from '../authorization/types.js';
import { listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { withTransaction, type TransactionClient } from '../db/transaction.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { KODE_OPERATING_ROLE_KEYS } from './role-model.js';
import type {
  ApproveMemberInput,
  DirectoryUserLookup,
  InviteMemberInput,
  InviteMemberResult,
  ListMembersOptions,
  OfficeRecord,
  OrganizationDirectoryStore,
  OrganizationMemberRecord,
  OrganizationRecord,
  OrganizationRoleRecord,
  RejectMemberInput,
  UpdateMemberAccessInput,
} from './store.js';

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  access_status: string;
  is_active: boolean;
};

type MemberRow = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  department: string | null;
  username: string | null;
  employee_code: string | null;
  role_key: string | null;
  office_id: string | null;
  status: MembershipStatus;
  account_status: AccountStatus | null;
};

type OfficeRow = {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  is_primary: boolean;
  is_active: boolean;
  settings: Record<string, unknown> | null;
};

type RoleRow = {
  id: string;
  organization_id: string;
  role_key: string;
  role_label: string;
  is_admin_role: boolean;
  is_manager_role: boolean;
  is_active: boolean;
};

type UserLookupRow = {
  user_id: string;
  email: string | null;
  account_status: AccountStatus;
  full_name: string | null;
};

type ActiveMembershipRow = {
  organization_id: string;
  status: MembershipStatus;
};

function serializeOrganization(row: OrganizationRow): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    accessStatus: row.access_status,
    isActive: row.is_active,
  };
}

function serializeMember(row: MemberRow): OrganizationMemberRecord {
  return {
    userId: row.user_id,
    email: row.email,
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    jobTitle: row.job_title,
    department: row.department,
    username: row.username,
    employeeCode: row.employee_code,
    roleKey: row.role_key,
    officeId: row.office_id,
    status: row.status,
    accountStatus: row.account_status,
  };
}

function serializeOffice(row: OfficeRow): OfficeRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    isPrimary: row.is_primary,
    isActive: row.is_active,
    settings:
      row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
        ? row.settings
        : {},
  };
}

function serializeRole(row: RoleRow): OrganizationRoleRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    roleKey: row.role_key,
    roleLabel: row.role_label,
    isAdminRole: row.is_admin_role,
    isManagerRole: row.is_manager_role,
    isActive: row.is_active,
  };
}

const MEMBER_SELECT = `
  SELECT
    m.user_id,
    u.email,
    p.full_name,
    p.avatar_url,
    p.job_title,
    p.department,
    p.username,
    p.employee_code,
    m.role_key,
    m.office_id,
    m.status,
    u.account_status
  FROM organizations.memberships m
  LEFT JOIN identity.users u
    ON u.id = m.user_id
  LEFT JOIN identity.user_profiles p
    ON p.user_id = m.user_id
`;

async function loadMember(
  client: TransactionClient | typeof db,
  organizationId: string,
  userId: string,
): Promise<OrganizationMemberRecord | null> {
  const result = await client.query<MemberRow>(
    `
      ${MEMBER_SELECT}
      WHERE m.organization_id = $1
        AND m.user_id = $2
      LIMIT 1
    `,
    [organizationId, userId],
  );

  return result.rows[0] ? serializeMember(result.rows[0]) : null;
}

async function resolveRole(
  client: TransactionClient | typeof db,
  organizationId: string,
  roleKey: string,
): Promise<OrganizationRoleRecord> {
  const result = await client.query<RoleRow>(
    `
      SELECT
        id,
        organization_id,
        role_key,
        role_label,
        is_admin_role,
        is_manager_role,
        is_active
      FROM organizations.roles
      WHERE organization_id = $1
        AND role_key = $2
        AND is_active = TRUE
      LIMIT 1
    `,
    [organizationId, roleKey],
  );

  if (!result.rows[0]) {
    throw new ValidationError('The selected role is not available.');
  }

  return serializeRole(result.rows[0]);
}

async function assertOfficeInOrganization(
  client: TransactionClient | typeof db,
  organizationId: string,
  officeId: string | null | undefined,
) {
  if (!officeId) {
    return;
  }

  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM organizations.offices
      WHERE id = $1
        AND organization_id = $2
        AND is_active = TRUE
      LIMIT 1
    `,
    [officeId, organizationId],
  );

  if (!result.rows[0]) {
    throw new ValidationError('Selected office was not found in this organization.');
  }
}

export class PostgresOrganizationDirectoryStore
  implements OrganizationDirectoryStore
{
  async getOrganization(
    organizationId: string,
  ): Promise<OrganizationRecord | null> {
    const result = await db.query<OrganizationRow>(
      `
        SELECT id, name, slug, status, access_status, is_active
        FROM organizations.organizations
        WHERE id = $1
      `,
      [organizationId],
    );

    return result.rows[0] ? serializeOrganization(result.rows[0]) : null;
  }

  async listMembers(
    organizationId: string,
    options: ListMembersOptions = {},
  ): Promise<{ members: OrganizationMemberRecord[]; hasMore: boolean }> {
    const statuses = options.statuses ?? (['active'] as MembershipStatus[]);
    const limit = listLimit(options.limit);
    const result = await db.query<MemberRow>(
      `
        ${MEMBER_SELECT}
        WHERE m.organization_id = $1
          AND m.status = ANY($2::text[])
        ORDER BY p.full_name NULLS LAST, m.user_id
        LIMIT $3 OFFSET $4
      `,
      [organizationId, statuses, limit + 1, listOffset(options.offset)],
    );

    const paged = pageOf(result.rows.map(serializeMember), limit);
    return { members: paged.rows, hasMore: paged.hasMore };
  }

  async getMember(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMemberRecord | null> {
    return loadMember(db, organizationId, userId);
  }

  async listOffices(
    organizationId: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<OfficeRecord[]> {
    const result = await db.query<OfficeRow>(
      `
        SELECT id, organization_id, name, slug, is_primary, is_active, settings
        FROM organizations.offices
        WHERE organization_id = $1
          AND ($2::boolean OR is_active = TRUE)
        ORDER BY is_primary DESC, name ASC, id ASC
        LIMIT 200
      `,
      [organizationId, Boolean(options.includeInactive)],
    );

    return result.rows.map(serializeOffice);
  }

  async getOffice(
    organizationId: string,
    officeId: string,
  ): Promise<OfficeRecord | null> {
    const result = await db.query<OfficeRow>(
      `
        SELECT id, organization_id, name, slug, is_primary, is_active, settings
        FROM organizations.offices
        WHERE id = $1
          AND organization_id = $2
      `,
      [officeId, organizationId],
    );

    return result.rows[0] ? serializeOffice(result.rows[0]) : null;
  }

  async listOperatingRoles(
    organizationId: string,
  ): Promise<OrganizationRoleRecord[]> {
    const result = await db.query<RoleRow>(
      `
        SELECT
          id,
          organization_id,
          role_key,
          role_label,
          is_admin_role,
          is_manager_role,
          is_active
        FROM organizations.roles
        WHERE organization_id = $1
          AND role_key = ANY($2::text[])
          AND is_active = TRUE
        ORDER BY role_key
      `,
      [organizationId, [...KODE_OPERATING_ROLE_KEYS]],
    );

    return result.rows.map(serializeRole);
  }

  async getRoleByKey(
    organizationId: string,
    roleKey: string,
  ): Promise<OrganizationRoleRecord | null> {
    try {
      return await resolveRole(db, organizationId, roleKey);
    } catch (error) {
      if (error instanceof ValidationError) {
        return null;
      }
      throw error;
    }
  }

  async findUserByEmail(
    emailNormalized: string,
  ): Promise<DirectoryUserLookup | null> {
    const result = await db.query<UserLookupRow>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.account_status,
          p.full_name
        FROM identity.users u
        LEFT JOIN identity.user_profiles p
          ON p.user_id = u.id
        WHERE u.email_normalized = $1
        LIMIT 1
      `,
      [emailNormalized],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      email: row.email,
      accountStatus: row.account_status,
      fullName: row.full_name,
    };
  }

  async inviteMember(input: InviteMemberInput): Promise<InviteMemberResult> {
    const emailNormalized = normalizeEmail(input.email);
    if (!emailNormalized) {
      throw new ValidationError('Email is required.');
    }

    return withTransaction(async (client) => {
      const role = await resolveRole(client, input.organizationId, input.roleKey);
      await assertOfficeInOrganization(
        client,
        input.organizationId,
        input.officeId,
      );

      const existing = await this.findUserByEmailInClient(client, emailNormalized);

      if (!existing) {
        const userId = randomUUID();
        const membershipId = randomUUID();

        await client.query(
          `
            INSERT INTO identity.users (
              id,
              email,
              email_normalized,
              is_active,
              account_status
            )
            VALUES ($1, $2, $3, FALSE, 'pending')
          `,
          [userId, emailNormalized, emailNormalized],
        );

        await client.query(
          `
            INSERT INTO identity.user_profiles (
              user_id,
              full_name,
              primary_role_key,
              office_id
            )
            VALUES ($1, $2, $3, $4)
          `,
          [
            userId,
            input.fullName.trim() || null,
            role.roleKey,
            input.officeId ?? null,
          ],
        );

        await client.query(
          `
            INSERT INTO organizations.memberships (
              id,
              organization_id,
              user_id,
              role_id,
              role_key,
              status,
              invited_by,
              office_id
            )
            VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
          `,
          [
            membershipId,
            input.organizationId,
            userId,
            role.id,
            role.roleKey,
            input.invitedBy,
            input.officeId ?? null,
          ],
        );

        return {
          status: 'invite_created',
          userId,
          membershipId,
          message:
            'Invite created. The user can sign up with this email and will be linked to your organization.',
        };
      }

      const activeElsewhere = await client.query<ActiveMembershipRow>(
        `
          SELECT organization_id, status
          FROM organizations.memberships
          WHERE user_id = $1
            AND status = 'active'
            AND organization_id <> $2
          LIMIT 1
        `,
        [existing.userId, input.organizationId],
      );

      if (activeElsewhere.rows[0]) {
        throw new ConflictError(
          'MEMBERSHIP_EXISTS',
          'That user already has an active membership in another organization.',
        );
      }

      const membershipId = randomUUID();
      const now = new Date();

      await client.query(
        `
          INSERT INTO organizations.memberships (
            id,
            organization_id,
            user_id,
            role_id,
            role_key,
            status,
            invited_by,
            office_id,
            joined_at,
            removed_at,
            removed_by
          )
          VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, NULL, NULL)
          ON CONFLICT (organization_id, user_id) DO UPDATE SET
            role_id = EXCLUDED.role_id,
            role_key = EXCLUDED.role_key,
            status = 'active',
            invited_by = EXCLUDED.invited_by,
            office_id = COALESCE(EXCLUDED.office_id, organizations.memberships.office_id),
            joined_at = COALESCE(organizations.memberships.joined_at, EXCLUDED.joined_at),
            removed_at = NULL,
            removed_by = NULL,
            updated_at = NOW()
          RETURNING id
        `,
        [
          membershipId,
          input.organizationId,
          existing.userId,
          role.id,
          role.roleKey,
          input.invitedBy,
          input.officeId ?? null,
          now,
        ],
      );

      await client.query(
        `
          UPDATE identity.users
          SET
            account_status = 'active',
            is_active = TRUE,
            updated_at = NOW()
          WHERE id = $1
        `,
        [existing.userId],
      );

      await client.query(
        `
          INSERT INTO identity.user_profiles (
            user_id,
            full_name,
            primary_role_key,
            office_id,
            approved_at,
            approved_by,
            rejected_at,
            rejected_by,
            rejection_reason,
            is_suspended,
            suspended_at,
            suspended_by,
            suspension_reason,
            deleted_at,
            deleted_by,
            deletion_reason
          )
          VALUES (
            $1, $2, $3, $4, NOW(), $5,
            NULL, NULL, NULL,
            FALSE, NULL, NULL, NULL,
            NULL, NULL, NULL
          )
          ON CONFLICT (user_id) DO UPDATE SET
            full_name = COALESCE(identity.user_profiles.full_name, EXCLUDED.full_name),
            primary_role_key = EXCLUDED.primary_role_key,
            office_id = COALESCE(EXCLUDED.office_id, identity.user_profiles.office_id),
            approved_at = NOW(),
            approved_by = EXCLUDED.approved_by,
            rejected_at = NULL,
            rejected_by = NULL,
            rejection_reason = NULL,
            is_suspended = FALSE,
            suspended_at = NULL,
            suspended_by = NULL,
            suspension_reason = NULL,
            deleted_at = NULL,
            deleted_by = NULL,
            deletion_reason = NULL,
            updated_at = NOW()
        `,
        [
          existing.userId,
          input.fullName.trim() || existing.fullName,
          role.roleKey,
          input.officeId ?? null,
          input.invitedBy,
        ],
      );

      const membership = await client.query<{ id: string }>(
        `
          SELECT id
          FROM organizations.memberships
          WHERE organization_id = $1
            AND user_id = $2
        `,
        [input.organizationId, existing.userId],
      );

      return {
        status: 'linked',
        userId: existing.userId,
        membershipId: membership.rows[0]?.id ?? membershipId,
        message: 'User linked successfully and marked active.',
      };
    });
  }

  async approveMember(
    input: ApproveMemberInput,
  ): Promise<OrganizationMemberRecord> {
    return withTransaction(async (client) => {
      const existing = await loadMember(
        client,
        input.organizationId,
        input.userId,
      );
      if (!existing) {
        throw new NotFoundError(
          'MEMBER_NOT_FOUND',
          'The organization member was not found.',
        );
      }

      const role = await resolveRole(client, input.organizationId, input.roleKey);
      await assertOfficeInOrganization(
        client,
        input.organizationId,
        input.officeId,
      );

      await client.query(
        `
          UPDATE organizations.memberships
          SET
            role_id = $1,
            role_key = $2,
            status = 'active',
            office_id = COALESCE($3, office_id),
            joined_at = COALESCE(joined_at, NOW()),
            removed_at = NULL,
            removed_by = NULL,
            updated_at = NOW()
          WHERE organization_id = $4
            AND user_id = $5
        `,
        [
          role.id,
          role.roleKey,
          input.officeId ?? null,
          input.organizationId,
          input.userId,
        ],
      );

      await client.query(
        `
          UPDATE identity.users
          SET
            account_status = 'active',
            is_active = TRUE,
            updated_at = NOW()
          WHERE id = $1
        `,
        [input.userId],
      );

      await client.query(
        `
          INSERT INTO identity.user_profiles (
            user_id,
            primary_role_key,
            office_id,
            approved_at,
            approved_by,
            rejected_at,
            rejected_by,
            rejection_reason,
            is_suspended,
            suspended_at,
            suspended_by,
            suspension_reason
          )
          VALUES (
            $1, $2, $3, NOW(), $4,
            NULL, NULL, NULL,
            FALSE, NULL, NULL, NULL
          )
          ON CONFLICT (user_id) DO UPDATE SET
            primary_role_key = EXCLUDED.primary_role_key,
            office_id = COALESCE(EXCLUDED.office_id, identity.user_profiles.office_id),
            approved_at = NOW(),
            approved_by = EXCLUDED.approved_by,
            rejected_at = NULL,
            rejected_by = NULL,
            rejection_reason = NULL,
            is_suspended = FALSE,
            suspended_at = NULL,
            suspended_by = NULL,
            suspension_reason = NULL,
            updated_at = NOW()
        `,
        [
          input.userId,
          role.roleKey,
          input.officeId ?? null,
          input.approvedBy,
        ],
      );

      const member = await loadMember(client, input.organizationId, input.userId);
      if (!member) {
        throw new NotFoundError(
          'MEMBER_NOT_FOUND',
          'The organization member was not found.',
        );
      }
      return member;
    });
  }

  async rejectMember(
    input: RejectMemberInput,
  ): Promise<OrganizationMemberRecord> {
    return withTransaction(async (client) => {
      const existing = await loadMember(
        client,
        input.organizationId,
        input.userId,
      );
      if (!existing) {
        throw new NotFoundError(
          'MEMBER_NOT_FOUND',
          'The organization member was not found.',
        );
      }

      await client.query(
        `
          UPDATE organizations.memberships
          SET
            status = 'removed',
            removed_at = NOW(),
            removed_by = $1,
            updated_at = NOW()
          WHERE organization_id = $2
            AND user_id = $3
        `,
        [input.rejectedBy, input.organizationId, input.userId],
      );

      await client.query(
        `
          UPDATE identity.users
          SET
            account_status = 'rejected',
            is_active = FALSE,
            updated_at = NOW()
          WHERE id = $1
        `,
        [input.userId],
      );

      await client.query(
        `
          INSERT INTO identity.user_profiles (
            user_id,
            rejected_at,
            rejected_by,
            rejection_reason,
            is_suspended
          )
          VALUES ($1, NOW(), $2, $3, FALSE)
          ON CONFLICT (user_id) DO UPDATE SET
            rejected_at = NOW(),
            rejected_by = EXCLUDED.rejected_by,
            rejection_reason = EXCLUDED.rejection_reason,
            is_suspended = FALSE,
            updated_at = NOW()
        `,
        [input.userId, input.rejectedBy, input.reason ?? null],
      );

      const member = await loadMember(client, input.organizationId, input.userId);
      if (!member) {
        throw new NotFoundError(
          'MEMBER_NOT_FOUND',
          'The organization member was not found.',
        );
      }
      return member;
    });
  }

  async updateMemberAccess(
    input: UpdateMemberAccessInput,
  ): Promise<OrganizationMemberRecord> {
    return withTransaction(async (client) => {
      const existing = await loadMember(
        client,
        input.organizationId,
        input.userId,
      );
      if (!existing) {
        throw new NotFoundError(
          'MEMBER_NOT_FOUND',
          'The organization member was not found.',
        );
      }

      const role = await resolveRole(client, input.organizationId, input.roleKey);
      if (input.changeOffice) {
        await assertOfficeInOrganization(
          client,
          input.organizationId,
          input.officeId,
        );
      }

      await client.query(
        `
          UPDATE organizations.memberships
          SET
            role_id = $1,
            role_key = $2,
            office_id = CASE
              WHEN $3::boolean THEN $4
              ELSE office_id
            END,
            updated_at = NOW()
          WHERE organization_id = $5
            AND user_id = $6
        `,
        [
          role.id,
          role.roleKey,
          input.changeOffice,
          input.changeOffice ? (input.officeId ?? null) : null,
          input.organizationId,
          input.userId,
        ],
      );

      await client.query(
        `
          INSERT INTO identity.user_profiles (
            user_id,
            primary_role_key,
            office_id
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id) DO UPDATE SET
            primary_role_key = EXCLUDED.primary_role_key,
            office_id = CASE
              WHEN $4::boolean THEN EXCLUDED.office_id
              ELSE identity.user_profiles.office_id
            END,
            updated_at = NOW()
        `,
        [
          input.userId,
          role.roleKey,
          input.changeOffice ? (input.officeId ?? null) : null,
          input.changeOffice,
        ],
      );

      const member = await loadMember(client, input.organizationId, input.userId);
      if (!member) {
        throw new NotFoundError(
          'MEMBER_NOT_FOUND',
          'The organization member was not found.',
        );
      }
      return member;
    });
  }

  private async findUserByEmailInClient(
    client: TransactionClient,
    emailNormalized: string,
  ): Promise<DirectoryUserLookup | null> {
    const result = await client.query<UserLookupRow>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.account_status,
          p.full_name
        FROM identity.users u
        LEFT JOIN identity.user_profiles p
          ON p.user_id = u.id
        WHERE u.email_normalized = $1
        LIMIT 1
      `,
      [emailNormalized],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      email: row.email,
      accountStatus: row.account_status,
      fullName: row.full_name,
    };
  }
}
