import type { MembershipStatus } from '../authorization/types.js';

export type OrganizationRecord = {
  id: string;
  name: string;
  slug: string;
  status: string;
  accessStatus: string;
  isActive: boolean;
};

export type OrganizationMemberRecord = {
  userId: string;
  fullName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
  username: string | null;
  employeeCode: string | null;
  roleKey: string | null;
  officeId: string | null;
  status: MembershipStatus;
};

export type OfficeRecord = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  isPrimary: boolean;
  isActive: boolean;
};

export type OrganizationRoleRecord = {
  id: string;
  organizationId: string;
  roleKey: string;
  roleLabel: string;
  isAdminRole: boolean;
  isManagerRole: boolean;
  isActive: boolean;
};

export type OrganizationDirectoryStore = {
  getOrganization(
    organizationId: string,
  ): Promise<OrganizationRecord | null>;
  listMembers(
    organizationId: string,
  ): Promise<OrganizationMemberRecord[]>;
  listOffices(
    organizationId: string,
    options?: { includeInactive?: boolean },
  ): Promise<OfficeRecord[]>;
  getOffice(
    organizationId: string,
    officeId: string,
  ): Promise<OfficeRecord | null>;
  listOperatingRoles(
    organizationId: string,
  ): Promise<OrganizationRoleRecord[]>;
};
