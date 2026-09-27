import type {
  AccountStatus,
  MembershipStatus,
} from '../authorization/types.js';

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
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
  username: string | null;
  employeeCode: string | null;
  roleKey: string | null;
  officeId: string | null;
  status: MembershipStatus;
  accountStatus: AccountStatus | null;
};

export type OfficeRecord = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  isPrimary: boolean;
  isActive: boolean;
  settings: Record<string, unknown>;
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

export type DirectoryUserLookup = {
  userId: string;
  email: string | null;
  accountStatus: AccountStatus;
  fullName: string | null;
};

export type InviteMemberInput = {
  organizationId: string;
  email: string;
  fullName: string;
  roleKey: string;
  invitedBy: string;
  officeId?: string | null;
};

export type InviteMemberResult = {
  status: 'linked' | 'invite_created';
  userId: string;
  membershipId: string;
  message: string;
};

export type ApproveMemberInput = {
  organizationId: string;
  userId: string;
  roleKey: string;
  approvedBy: string;
  officeId?: string | null;
};

export type RejectMemberInput = {
  organizationId: string;
  userId: string;
  rejectedBy: string;
  reason?: string | null;
};

export type UpdateMemberAccessInput = {
  organizationId: string;
  userId: string;
  roleKey: string;
  officeId?: string | null;
  changeOffice: boolean;
};

export type ListMembersOptions = {
  statuses?: MembershipStatus[];
  limit?: number;
  offset?: number;
};

export type OrganizationDirectoryStore = {
  getOrganization(
    organizationId: string,
  ): Promise<OrganizationRecord | null>;
  listMembers(
    organizationId: string,
    options?: ListMembersOptions,
  ): Promise<{ members: OrganizationMemberRecord[]; hasMore: boolean }>;
  getMember(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMemberRecord | null>;
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
  getRoleByKey(
    organizationId: string,
    roleKey: string,
  ): Promise<OrganizationRoleRecord | null>;
  findUserByEmail(
    emailNormalized: string,
  ): Promise<DirectoryUserLookup | null>;
  inviteMember(input: InviteMemberInput): Promise<InviteMemberResult>;
  approveMember(input: ApproveMemberInput): Promise<OrganizationMemberRecord>;
  rejectMember(input: RejectMemberInput): Promise<OrganizationMemberRecord>;
  updateMemberAccess(
    input: UpdateMemberAccessInput,
  ): Promise<OrganizationMemberRecord>;
};
