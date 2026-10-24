import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import type { TransactionClient } from '../db/transaction.js';

export type DirectoryAccountAction =
  | 'suspend'
  | 'restore'
  | 'soft_delete'
  | 'hard_delete';

export type DirectoryAccountActionInput = {
  organizationId: string;
  actorUserId: string;
  targetUserId: string;
  action: DirectoryAccountAction;
  reason?: string | null;
};

type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

async function requireMember(
  client: Queryable,
  organizationId: string,
  userId: string,
) {
  const result = await client.query(
    `
      SELECT
        m.user_id,
        m.role_key,
        m.status,
        u.account_status,
        u.email_normalized,
        u.deleted_at,
        (c.user_id IS NOT NULL) AS has_password
      FROM organizations.memberships m
      INNER JOIN identity.users u ON u.id = m.user_id
      LEFT JOIN identity.password_credentials c ON c.user_id = u.id
      WHERE m.organization_id = $1
        AND m.user_id = $2
    `,
    [organizationId, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError('MEMBER_NOT_FOUND', 'The organization member was not found.');
  }
  return row;
}

async function assertNotLastActiveAdmin(
  client: Queryable,
  organizationId: string,
  targetUserId: string,
) {
  const target = await client.query(
    `
      SELECT COALESCE(r.is_admin_role, FALSE) OR m.role_key = 'admin' AS is_admin
      FROM organizations.memberships m
      LEFT JOIN organizations.roles r ON r.id = m.role_id
      INNER JOIN identity.users u ON u.id = m.user_id
      WHERE m.organization_id = $1
        AND m.user_id = $2
        AND m.status = 'active'
        AND u.account_status = 'active'
    `,
    [organizationId, targetUserId],
  );
  if (!target.rows[0]?.is_admin) return;

  const remaining = await client.query(
    `
      SELECT COUNT(*)::int AS count
      FROM organizations.memberships m
      LEFT JOIN organizations.roles r ON r.id = m.role_id
      INNER JOIN identity.users u ON u.id = m.user_id
      WHERE m.organization_id = $1
        AND m.status = 'active'
        AND u.account_status = 'active'
        AND u.is_active = TRUE
        AND (COALESCE(r.is_admin_role, FALSE) OR m.role_key = 'admin')
        AND m.user_id <> $2
    `,
    [organizationId, targetUserId],
  );
  if ((remaining.rows[0]?.count as number) < 1) {
    throw new ForbiddenError(
      'LAST_ADMIN',
      'You cannot suspend or delete the last active administrator.',
    );
  }
}

export async function applyDirectoryAccountAction(
  client: Queryable | TransactionClient,
  input: DirectoryAccountActionInput,
): Promise<void> {
  const { organizationId, actorUserId, targetUserId, action } = input;
  const reason = input.reason?.trim() || null;
  const member = await requireMember(client, organizationId, targetUserId);

  if (action === 'restore') {
    if (!member.email_normalized && member.account_status === 'deleted') {
      throw new ValidationError(
        'This account was permanently deleted. Invite the person again with a new account.',
      );
    }
    await client.query(
      `
        UPDATE identity.users
        SET account_status = 'active',
            is_active = TRUE,
            deleted_at = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [targetUserId],
    );
    await client.query(
      `
        UPDATE identity.user_profiles
        SET is_suspended = FALSE,
            suspended_at = NULL,
            suspended_by = NULL,
            suspension_reason = NULL,
            deleted_at = NULL,
            deleted_by = NULL,
            deletion_reason = NULL,
            rejected_at = NULL,
            rejected_by = NULL,
            rejection_reason = NULL,
            updated_at = NOW()
        WHERE user_id = $1
      `,
      [targetUserId],
    );
    await client.query(
      `
        UPDATE organizations.memberships
        SET status = 'active',
            removed_at = NULL,
            removed_by = NULL,
            updated_at = NOW()
        WHERE organization_id = $1
          AND user_id = $2
      `,
      [organizationId, targetUserId],
    );
    return;
  }

  await assertNotLastActiveAdmin(client, organizationId, targetUserId);

  if (action === 'suspend') {
    await client.query(
      `
        UPDATE identity.users
        SET account_status = 'suspended', is_active = FALSE, updated_at = NOW()
        WHERE id = $1
      `,
      [targetUserId],
    );
    await client.query(
      `
        UPDATE identity.user_profiles
        SET is_suspended = TRUE,
            suspended_at = NOW(),
            suspended_by = $2,
            suspension_reason = $3,
            updated_at = NOW()
        WHERE user_id = $1
      `,
      [targetUserId, actorUserId, reason],
    );
    await client.query(
      `
        UPDATE organizations.memberships
        SET status = 'suspended', updated_at = NOW()
        WHERE organization_id = $1
          AND user_id = $2
      `,
      [organizationId, targetUserId],
    );
    return;
  }

  await client.query(
    `
      UPDATE identity.users
      SET account_status = 'deleted',
          is_active = FALSE,
          deleted_at = COALESCE(deleted_at, NOW()),
          email_normalized = CASE WHEN $2 THEN NULL ELSE email_normalized END,
          updated_at = NOW()
      WHERE id = $1
    `,
    [targetUserId, action === 'hard_delete'],
  );
  await client.query(
    `
      UPDATE identity.user_profiles
      SET deleted_at = NOW(),
          deleted_by = $2,
          deletion_reason = $3,
          is_suspended = FALSE,
          updated_at = NOW()
      WHERE user_id = $1
    `,
    [targetUserId, actorUserId, reason],
  );
  await client.query(
    `
      UPDATE identity.password_reset_tokens
      SET used_at = NOW()
      WHERE user_id = $1
        AND used_at IS NULL
    `,
    [targetUserId],
  );
  await client.query(
    `
      UPDATE organizations.memberships
      SET status = 'removed',
          removed_at = NOW(),
          removed_by = $3,
          updated_at = NOW()
      WHERE organization_id = $1
        AND user_id = $2
    `,
    [organizationId, targetUserId, actorUserId],
  );

  if (action === 'hard_delete') {
    await client.query(
      `DELETE FROM identity.password_credentials WHERE user_id = $1`,
      [targetUserId],
    );
  }
}
