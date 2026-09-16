import { ForbiddenError } from '../http/errors.js';
import type { AuthContext } from '../authorization/types.js';

export function assertAuthenticatedAccount(context: AuthContext): void {
  const { actor } = context;

  if (!actor.isActive || actor.deletedAt || actor.accountStatus === 'deleted') {
    throw new ForbiddenError(
      'ACCOUNT_INACTIVE',
      'The account is not active.',
    );
  }

  if (actor.accountStatus === 'suspended') {
    throw new ForbiddenError(
      'ACCOUNT_SUSPENDED',
      'The account is suspended.',
    );
  }

  if (actor.accountStatus !== 'active') {
    throw new ForbiddenError(
      'ACCOUNT_NOT_ACTIVE',
      'The account is not approved for access.',
    );
  }
}

export function rejectClientUserOverride(
  context: AuthContext,
  clientUserId: string | null | undefined,
): void {
  if (clientUserId != null && clientUserId !== context.actor.userId) {
    throw new ForbiddenError(
      'USER_OVERRIDE_REJECTED',
      'Client-supplied user id is not authoritative and does not match the authenticated identity.',
    );
  }
}
