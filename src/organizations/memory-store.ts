import type { MembershipStatus } from '../authorization/types.js';
import { KODE_OPERATING_ROLE_KEYS } from './role-model.js';
import type {
  OfficeRecord,
  OrganizationDirectoryStore,
  OrganizationMemberRecord,
  OrganizationRecord,
  OrganizationRoleRecord,
} from './store.js';

export class MemoryOrganizationDirectoryStore
  implements OrganizationDirectoryStore
{
  organizations: OrganizationRecord[] = [];
  members: Array<OrganizationMemberRecord & { organizationId: string }> = [];
  offices: OfficeRecord[] = [];
  roles: OrganizationRoleRecord[] = [];

  seedOrganization(organization: OrganizationRecord) {
    this.organizations.push(organization);
  }

  seedMember(
    member: OrganizationMemberRecord & { organizationId: string },
  ) {
    this.members.push(member);
  }

  seedOffice(office: OfficeRecord) {
    this.offices.push(office);
  }

  seedRole(role: OrganizationRoleRecord) {
    this.roles.push(role);
  }

  async getOrganization(
    organizationId: string,
  ): Promise<OrganizationRecord | null> {
    return this.organizations.find((row) => row.id === organizationId) ?? null;
  }

  async listMembers(
    organizationId: string,
  ): Promise<OrganizationMemberRecord[]> {
    return this.members
      .filter(
        (member) =>
          member.organizationId === organizationId && member.status === 'active',
      )
      .map(({ organizationId: _organizationId, ...member }) => member);
  }

  async listOffices(
    organizationId: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<OfficeRecord[]> {
    return this.offices.filter((office) => {
      if (office.organizationId !== organizationId) {
        return false;
      }

      return options.includeInactive ? true : office.isActive;
    });
  }

  async getOffice(
    organizationId: string,
    officeId: string,
  ): Promise<OfficeRecord | null> {
    return (
      this.offices.find(
        (office) =>
          office.id === officeId && office.organizationId === organizationId,
      ) ?? null
    );
  }

  async listOperatingRoles(
    organizationId: string,
  ): Promise<OrganizationRoleRecord[]> {
    const operating = new Set<string>(KODE_OPERATING_ROLE_KEYS);

    return this.roles.filter(
      (role) =>
        role.organizationId === organizationId &&
        role.isActive &&
        operating.has(role.roleKey),
    );
  }
}

export function seedActiveMember(
  store: MemoryOrganizationDirectoryStore,
  input: {
    organizationId: string;
    userId: string;
    roleKey?: string | null;
    officeId?: string | null;
    status?: MembershipStatus;
    fullName?: string | null;
    email?: string | null;
  },
) {
  store.seedMember({
    organizationId: input.organizationId,
    userId: input.userId,
    fullName: input.fullName ?? 'Test User',
    email: input.email ?? null,
    avatarUrl: null,
    jobTitle: null,
    department: null,
    username: null,
    employeeCode: null,
    roleKey: input.roleKey ?? 'admin',
    officeId: input.officeId ?? null,
    status: input.status ?? 'active',
  });
}
