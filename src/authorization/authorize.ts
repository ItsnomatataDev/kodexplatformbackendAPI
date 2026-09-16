import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { hasPermission } from './permissions.js';
import type {
  AuthorizationDecision,
  AuthorizeInput,
  AuthContext,
} from './types.js';

function allow(): AuthorizationDecision {
  return {
    allowed: true,
    code: 'ALLOW',
    reason: 'The operation is allowed.',
  };
}

function deny(
  code: AuthorizationDecision['code'],
  reason: string,
): AuthorizationDecision {
  return {
    allowed: false,
    code,
    reason,
  };
}

function organizationIsAccessible(context: AuthContext): boolean {
  const { organization } = context;

  if (!organization.isActive) {
    return false;
  }

  if (organization.status === 'suspended') {
    return false;
  }

  if (
    organization.accessStatus === 'suspended' ||
    organization.accessStatus === 'cancelled'
  ) {
    return false;
  }

  return true;
}

export function authorize(input: AuthorizeInput): AuthorizationDecision {
  const { context, action, resource, requireOwnership = false } = input;

  if (!context) {
    return deny('UNAUTHENTICATED', 'Authentication is required.');
  }

  const { actor, membership } = context;

  if (!actor.isActive || actor.deletedAt) {
    return deny('ACCOUNT_INACTIVE', 'The account is not active.');
  }

  if (actor.accountStatus === 'suspended') {
    return deny('ACCOUNT_SUSPENDED', 'The account is suspended.');
  }

  if (actor.accountStatus !== 'active') {
    return deny(
      'ACCOUNT_NOT_ACTIVE',
      'The account is not approved for access.',
    );
  }

  if (membership.status !== 'active') {
    return deny(
      'MEMBERSHIP_INACTIVE',
      'The organization membership is not active.',
    );
  }

  if (!organizationIsAccessible(context)) {
    return deny(
      'ORGANIZATION_INACTIVE',
      'The organization is not active.',
    );
  }

  if (resource.organizationId !== membership.organizationId) {
    return deny(
      'CROSS_ORGANIZATION_ACCESS',
      'Resources cannot be accessed across organizations.',
    );
  }

  if (
    requireOwnership &&
    resource.ownerId &&
    resource.ownerId !== actor.userId
  ) {
    return deny('NOT_OWNER', 'This operation requires resource ownership.');
  }

  if (membership.isAdminRole) {
    return allow();
  }

  if (hasPermission(membership.permissions, action)) {
    return allow();
  }

  return deny(
    'INSUFFICIENT_PERMISSION',
    'The membership does not have permission for this operation.',
  );
}

export function assertAuthorized(input: AuthorizeInput): AuthContext {
  const decision = authorize(input);

  if (decision.allowed) {
    if (!input.context) {
      throw new UnauthorizedError();
    }

    return input.context;
  }

  if (decision.code === 'UNAUTHENTICATED') {
    throw new UnauthorizedError(decision.code, decision.reason);
  }

  throw new ForbiddenError(decision.code, decision.reason);
}
