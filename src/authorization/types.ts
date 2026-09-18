export type AccountStatus =
  | 'pending'
  | 'pending_approval'
  | 'active'
  | 'suspended'
  | 'rejected'
  | 'deleted';

export type MembershipStatus =
  | 'active'
  | 'pending'
  | 'suspended'
  | 'removed';

export type OrganizationStatus = 'active' | 'suspended';

export type OrganizationAccessStatus =
  | 'active'
  | 'trialing'
  | 'suspended'
  | 'cancelled';

export type Actor = {
  userId: string;
  email: string | null;
  isActive: boolean;
  accountStatus: AccountStatus;
  deletedAt: string | null;
};

export type OrganizationState = {
  organizationId: string;
  isActive: boolean;
  status: OrganizationStatus;
  accessStatus: OrganizationAccessStatus;
};

export type OrganizationMembership = {
  membershipId: string;
  organizationId: string;
  officeId: string | null;
  roleId: string | null;
  roleKey: string | null;
  status: MembershipStatus;
  isAdminRole: boolean;
  isManagerRole: boolean;
  permissions: unknown;
};

export type AuthContext = {
  actor: Actor;
  membership: OrganizationMembership;
  organization: OrganizationState;
};

export type ProtectedResource = {
  type: string;
  id?: string;
  organizationId: string;
  ownerId?: string | null;
};

export type AuthorizationCode =
  | 'ALLOW'
  | 'UNAUTHENTICATED'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'MEMBERSHIP_INACTIVE'
  | 'ORGANIZATION_INACTIVE'
  | 'CROSS_ORGANIZATION_ACCESS'
  | 'ORGANIZATION_OVERRIDE_REJECTED'
  | 'NOT_OWNER'
  | 'INSUFFICIENT_PERMISSION'
  | 'FORBIDDEN';

export type AuthorizationDecision = {
  allowed: boolean;
  code: AuthorizationCode;
  reason: string;
};

export type AuthorizeInput = {
  context: AuthContext | null | undefined;
  action: string;
  resource: ProtectedResource;
  requireOwnership?: boolean;
};
