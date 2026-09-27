import { randomUUID } from 'node:crypto';
import { listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { normalizeEmail } from '../auth/login.js';
import type { AccountStatus, MembershipStatus } from '../authorization/types.js';
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

type MemoryMember = OrganizationMemberRecord & {
  organizationId: string;
  membershipId: string;
};

type MemoryUser = {
  userId: string;
  email: string | null;
  emailNormalized: string;
  accountStatus: AccountStatus;
  isActive: boolean;
  fullName: string | null;
};

export class MemoryOrganizationDirectoryStore
  implements OrganizationDirectoryStore
{
  organizations: OrganizationRecord[] = [];
  members: MemoryMember[] = [];
  offices: OfficeRecord[] = [];
  roles: OrganizationRoleRecord[] = [];
  users: MemoryUser[] = [];

  seedOrganization(organization: OrganizationRecord) {
    this.organizations.push(organization);
  }

  seedMember(
    member: OrganizationMemberRecord & {
      organizationId: string;
      membershipId?: string;
    },
  ) {
    this.members.push({
      ...member,
      accountStatus: member.accountStatus ?? 'active',
      membershipId: member.membershipId ?? randomUUID(),
    });
    if (
      member.email &&
      !this.users.some((user) => user.userId === member.userId)
    ) {
      this.users.push({
        userId: member.userId,
        email: member.email,
        emailNormalized: normalizeEmail(member.email),
        accountStatus: member.accountStatus ?? 'active',
        isActive: (member.accountStatus ?? 'active') === 'active',
        fullName: member.fullName,
      });
    }
  }

  seedOffice(office: OfficeRecord) {
    this.offices.push(office);
  }

  seedRole(role: OrganizationRoleRecord) {
    this.roles.push(role);
  }

  seedUser(user: MemoryUser) {
    this.users.push(user);
  }

  async getOrganization(
    organizationId: string,
  ): Promise<OrganizationRecord | null> {
    return this.organizations.find((row) => row.id === organizationId) ?? null;
  }

  async listMembers(
    organizationId: string,
    options: ListMembersOptions = {},
  ): Promise<{ members: OrganizationMemberRecord[]; hasMore: boolean }> {
    const statuses = options.statuses ?? (['active'] as MembershipStatus[]);
    const ordered = this.members
      .filter(
        (member) =>
          member.organizationId === organizationId &&
          statuses.includes(member.status),
      )
      .map(({ organizationId: _organizationId, membershipId: _id, ...member }) =>
        member,
      );
    const offset = listOffset(options.offset);
    const limit = listLimit(options.limit);
    const paged = pageOf(ordered.slice(offset, offset + limit + 1), limit);
    return { members: paged.rows, hasMore: paged.hasMore };
  }

  async getMember(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMemberRecord | null> {
    const member = this.members.find(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );
    if (!member) {
      return null;
    }
    const { organizationId: _organizationId, membershipId: _id, ...rest } =
      member;
    return rest;
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

  async getRoleByKey(
    organizationId: string,
    roleKey: string,
  ): Promise<OrganizationRoleRecord | null> {
    return (
      this.roles.find(
        (role) =>
          role.organizationId === organizationId &&
          role.roleKey === roleKey &&
          role.isActive,
      ) ?? null
    );
  }

  async findUserByEmail(
    emailNormalized: string,
  ): Promise<DirectoryUserLookup | null> {
    const user = this.users.find(
      (row) => row.emailNormalized === emailNormalized,
    );
    if (!user) {
      return null;
    }
    return {
      userId: user.userId,
      email: user.email,
      accountStatus: user.accountStatus,
      fullName: user.fullName,
    };
  }

  async inviteMember(input: InviteMemberInput): Promise<InviteMemberResult> {
    const emailNormalized = normalizeEmail(input.email);
    if (!emailNormalized) {
      throw new ValidationError('Email is required.');
    }

    const role = await this.getRoleByKey(input.organizationId, input.roleKey);
    if (!role) {
      throw new ValidationError('The selected role is not available.');
    }

    if (input.officeId) {
      const office = await this.getOffice(input.organizationId, input.officeId);
      if (!office?.isActive) {
        throw new ValidationError(
          'Selected office was not found in this organization.',
        );
      }
    }

    const existing = await this.findUserByEmail(emailNormalized);
    if (!existing) {
      const userId = randomUUID();
      const membershipId = randomUUID();
      this.users.push({
        userId,
        email: emailNormalized,
        emailNormalized,
        accountStatus: 'pending',
        isActive: false,
        fullName: input.fullName.trim() || null,
      });
      this.members.push({
        organizationId: input.organizationId,
        membershipId,
        userId,
        email: emailNormalized,
        fullName: input.fullName.trim() || null,
        avatarUrl: null,
        jobTitle: null,
        department: null,
        username: null,
        employeeCode: null,
        roleKey: role.roleKey,
        officeId: input.officeId ?? null,
        status: 'pending',
        accountStatus: 'pending',
      });
      return {
        status: 'invite_created',
        userId,
        membershipId,
        message:
          'Invite created. The user can sign up with this email and will be linked to your organization.',
      };
    }

    const activeElsewhere = this.members.find(
      (member) =>
        member.userId === existing.userId &&
        member.status === 'active' &&
        member.organizationId !== input.organizationId,
    );
    if (activeElsewhere) {
      throw new ConflictError(
        'MEMBERSHIP_EXISTS',
        'That user already has an active membership in another organization.',
      );
    }

    const membershipId = randomUUID();
    const existingMembership = this.members.find(
      (member) =>
        member.organizationId === input.organizationId &&
        member.userId === existing.userId,
    );

    if (existingMembership) {
      existingMembership.roleKey = role.roleKey;
      existingMembership.status = 'active';
      existingMembership.accountStatus = 'active';
      existingMembership.officeId =
        input.officeId ?? existingMembership.officeId;
      existingMembership.fullName =
        existingMembership.fullName ?? (input.fullName.trim() || null);
    } else {
      this.members.push({
        organizationId: input.organizationId,
        membershipId,
        userId: existing.userId,
        email: existing.email,
        fullName: existing.fullName ?? (input.fullName.trim() || null),
        avatarUrl: null,
        jobTitle: null,
        department: null,
        username: null,
        employeeCode: null,
        roleKey: role.roleKey,
        officeId: input.officeId ?? null,
        status: 'active',
        accountStatus: 'active',
      });
    }

    const user = this.users.find((row) => row.userId === existing.userId);
    if (user) {
      user.accountStatus = 'active';
      user.isActive = true;
      user.fullName = user.fullName ?? (input.fullName.trim() || null);
    }

    return {
      status: 'linked',
      userId: existing.userId,
      membershipId: existingMembership?.membershipId ?? membershipId,
      message: 'User linked successfully and marked active.',
    };
  }

  async approveMember(
    input: ApproveMemberInput,
  ): Promise<OrganizationMemberRecord> {
    const member = this.members.find(
      (row) =>
        row.organizationId === input.organizationId &&
        row.userId === input.userId,
    );
    if (!member) {
      throw new NotFoundError(
        'MEMBER_NOT_FOUND',
        'The organization member was not found.',
      );
    }

    const role = await this.getRoleByKey(input.organizationId, input.roleKey);
    if (!role) {
      throw new ValidationError('The selected role is not available.');
    }

    if (input.officeId) {
      const office = await this.getOffice(input.organizationId, input.officeId);
      if (!office?.isActive) {
        throw new ValidationError(
          'Selected office was not found in this organization.',
        );
      }
    }

    member.roleKey = role.roleKey;
    member.status = 'active';
    member.accountStatus = 'active';
    if (input.officeId !== undefined) {
      member.officeId = input.officeId ?? member.officeId;
    }

    const user = this.users.find((row) => row.userId === input.userId);
    if (user) {
      user.accountStatus = 'active';
      user.isActive = true;
    }

    const { organizationId: _org, membershipId: _id, ...rest } = member;
    return rest;
  }

  async rejectMember(
    input: RejectMemberInput,
  ): Promise<OrganizationMemberRecord> {
    const member = this.members.find(
      (row) =>
        row.organizationId === input.organizationId &&
        row.userId === input.userId,
    );
    if (!member) {
      throw new NotFoundError(
        'MEMBER_NOT_FOUND',
        'The organization member was not found.',
      );
    }

    member.status = 'removed';
    member.accountStatus = 'rejected';

    const user = this.users.find((row) => row.userId === input.userId);
    if (user) {
      user.accountStatus = 'rejected';
      user.isActive = false;
    }

    const { organizationId: _org, membershipId: _id, ...rest } = member;
    return rest;
  }

  async updateMemberAccess(
    input: UpdateMemberAccessInput,
  ): Promise<OrganizationMemberRecord> {
    const member = this.members.find(
      (row) =>
        row.organizationId === input.organizationId &&
        row.userId === input.userId,
    );
    if (!member) {
      throw new NotFoundError(
        'MEMBER_NOT_FOUND',
        'The organization member was not found.',
      );
    }

    const role = await this.getRoleByKey(input.organizationId, input.roleKey);
    if (!role) {
      throw new ValidationError('The selected role is not available.');
    }

    if (input.changeOffice && input.officeId) {
      const office = await this.getOffice(input.organizationId, input.officeId);
      if (!office?.isActive) {
        throw new ValidationError(
          'Selected office was not found in this organization.',
        );
      }
    }

    member.roleKey = role.roleKey;
    if (input.changeOffice) {
      member.officeId = input.officeId ?? null;
    }

    const { organizationId: _org, membershipId: _id, ...rest } = member;
    return rest;
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
    accountStatus?: AccountStatus;
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
    accountStatus: input.accountStatus ?? 'active',
  });
}
