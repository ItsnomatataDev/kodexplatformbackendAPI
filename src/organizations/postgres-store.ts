import { db } from '../db/pool.js';
import { KODE_OPERATING_ROLE_KEYS } from './role-model.js';
import type {
  OfficeRecord,
  OrganizationDirectoryStore,
  OrganizationMemberRecord,
  OrganizationRecord,
  OrganizationRoleRecord,
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
  full_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  department: string | null;
  username: string | null;
  employee_code: string | null;
  role_key: string | null;
  office_id: string | null;
  status: OrganizationMemberRecord['status'];
};

type OfficeRow = {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  is_primary: boolean;
  is_active: boolean;
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
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    jobTitle: row.job_title,
    department: row.department,
    username: row.username,
    employeeCode: row.employee_code,
    roleKey: row.role_key,
    officeId: row.office_id,
    status: row.status,
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
  ): Promise<OrganizationMemberRecord[]> {
    const result = await db.query<MemberRow>(
      `
        SELECT
          m.user_id,
          p.full_name,
          p.avatar_url,
          p.job_title,
          p.department,
          p.username,
          p.employee_code,
          m.role_key,
          m.office_id,
          m.status
        FROM organizations.memberships m
        LEFT JOIN identity.user_profiles p
          ON p.user_id = m.user_id
        WHERE m.organization_id = $1
          AND m.status = 'active'
        ORDER BY p.full_name NULLS LAST, m.user_id
      `,
      [organizationId],
    );

    return result.rows.map(serializeMember);
  }

  async listOffices(
    organizationId: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<OfficeRecord[]> {
    const result = await db.query<OfficeRow>(
      `
        SELECT id, organization_id, name, slug, is_primary, is_active
        FROM organizations.offices
        WHERE organization_id = $1
          AND ($2::boolean OR is_active = TRUE)
        ORDER BY is_primary DESC, name ASC, id ASC
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
        SELECT id, organization_id, name, slug, is_primary, is_active
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
}
