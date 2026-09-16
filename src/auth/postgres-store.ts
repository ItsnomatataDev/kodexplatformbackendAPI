import { db } from '../db/pool.js';
import {
  withTransaction,
  type TransactionClient,
} from '../db/transaction.js';
import type { AccountStatus } from '../authorization/types.js';
import type {
  AuthStore,
  CreateRefreshTokenInput,
  CreateSessionInput,
  LoginIdentity,
  PasswordResetRecord,
  RefreshTokenRecord,
  SessionRecord,
} from './store.js';

type UserRow = {
  user_id: string;
  email: string | null;
  email_normalized: string | null;
  is_active: boolean;
  account_status: AccountStatus;
  deleted_at: Date | null;
  password_hash: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  revocation_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
};

type RefreshRow = {
  id: string;
  session_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  replaced_by: string | null;
};

type ResetRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
};

function executor(client?: TransactionClient) {
  return client ?? db;
}

function mapUser(row: UserRow): LoginIdentity {
  return {
    userId: row.user_id,
    email: row.email,
    emailNormalized: row.email_normalized,
    isActive: row.is_active,
    accountStatus: row.account_status,
    deletedAt: row.deleted_at,
    passwordHash: row.password_hash,
  };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  };
}

function mapRefresh(row: RefreshRow): RefreshTokenRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    replacedBy: row.replaced_by,
  };
}

function mapReset(row: ResetRow): PasswordResetRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

export class PostgresAuthStore implements AuthStore {
  async findLoginIdentityByEmail(emailNormalized: string) {
    const result = await db.query<UserRow>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.email_normalized,
          u.is_active,
          u.account_status,
          u.deleted_at,
          c.password_hash
        FROM identity.users u
        LEFT JOIN identity.password_credentials c
          ON c.user_id = u.id
        WHERE u.email_normalized = $1
      `,
      [emailNormalized],
    );

    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async findLoginIdentityById(userId: string) {
    const result = await db.query<UserRow>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.email_normalized,
          u.is_active,
          u.account_status,
          u.deleted_at,
          c.password_hash
        FROM identity.users u
        LEFT JOIN identity.password_credentials c
          ON c.user_id = u.id
        WHERE u.id = $1
      `,
      [userId],
    );

    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async upsertPasswordHash(
    userId: string,
    passwordHash: string,
    client?: TransactionClient,
  ) {
    await executor(client).query(
      `
        INSERT INTO identity.password_credentials (
          user_id,
          password_hash,
          algorithm
        )
        VALUES ($1, $2, 'argon2id')
        ON CONFLICT (user_id)
        DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          algorithm = 'argon2id',
          updated_at = NOW()
      `,
      [userId, passwordHash],
    );
  }

  async createSession(
    input: CreateSessionInput,
    client?: TransactionClient,
  ) {
    const result = await executor(client).query<SessionRow>(
      `
        INSERT INTO identity.sessions (
          user_id,
          expires_at,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, $3, $4)
        RETURNING
          id,
          user_id,
          created_at,
          expires_at,
          last_seen_at,
          revoked_at,
          revocation_reason,
          ip_address,
          user_agent
      `,
      [
        input.userId,
        input.expiresAt,
        input.ipAddress ?? null,
        input.userAgent ?? null,
      ],
    );

    return mapSession(result.rows[0]);
  }

  async getSession(sessionId: string) {
    const result = await db.query<SessionRow>(
      `
        SELECT
          id,
          user_id,
          created_at,
          expires_at,
          last_seen_at,
          revoked_at,
          revocation_reason,
          ip_address,
          user_agent
        FROM identity.sessions
        WHERE id = $1
      `,
      [sessionId],
    );

    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async listActiveSessions(userId: string) {
    const result = await db.query<SessionRow>(
      `
        SELECT
          id,
          user_id,
          created_at,
          expires_at,
          last_seen_at,
          revoked_at,
          revocation_reason,
          ip_address,
          user_agent
        FROM identity.sessions
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()
      `,
      [userId],
    );

    return result.rows.map(mapSession);
  }

  async touchSession(sessionId: string, at: Date) {
    await db.query(
      `
        UPDATE identity.sessions
        SET last_seen_at = $2
        WHERE id = $1
      `,
      [sessionId, at],
    );
  }

  async revokeSession(
    sessionId: string,
    reason: string,
    at: Date,
    client?: TransactionClient,
  ) {
    const result = await executor(client).query(
      `
        UPDATE identity.sessions
        SET
          revoked_at = $2,
          revocation_reason = $3
        WHERE id = $1
          AND revoked_at IS NULL
      `,
      [sessionId, at, reason],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async revokeAllSessionsForUser(
    userId: string,
    reason: string,
    at: Date,
    exceptSessionId?: string,
  ) {
    const result = await db.query(
      `
        UPDATE identity.sessions
        SET
          revoked_at = $2,
          revocation_reason = $3
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND ($4::uuid IS NULL OR id <> $4)
      `,
      [userId, at, reason, exceptSessionId ?? null],
    );

    return result.rowCount ?? 0;
  }

  async createRefreshToken(
    input: CreateRefreshTokenInput,
    client?: TransactionClient,
  ) {
    const result = await executor(client).query<RefreshRow>(
      `
        INSERT INTO identity.refresh_tokens (
          id,
          session_id,
          token_hash,
          expires_at
        )
        VALUES ($1, $2, $3, $4)
        RETURNING
          id,
          session_id,
          token_hash,
          created_at,
          expires_at,
          used_at,
          replaced_by
      `,
      [input.id, input.sessionId, input.tokenHash, input.expiresAt],
    );

    return mapRefresh(result.rows[0]);
  }

  async findRefreshTokenByHash(tokenHash: string) {
    const result = await db.query<RefreshRow>(
      `
        SELECT
          id,
          session_id,
          token_hash,
          created_at,
          expires_at,
          used_at,
          replaced_by
        FROM identity.refresh_tokens
        WHERE token_hash = $1
      `,
      [tokenHash],
    );

    return result.rows[0] ? mapRefresh(result.rows[0]) : null;
  }

  async markRefreshTokenUsed(
    tokenId: string,
    replacedBy: string,
    usedAt: Date,
    client?: TransactionClient,
  ) {
    await executor(client).query(
      `
        UPDATE identity.refresh_tokens
        SET
          used_at = $2,
          replaced_by = $3
        WHERE id = $1
      `,
      [tokenId, usedAt, replacedBy],
    );
  }

  async createPasswordResetToken(
    input: Omit<PasswordResetRecord, 'usedAt' | 'createdAt'> & {
      createdAt?: Date;
    },
  ) {
    const result = await db.query<ResetRow>(
      `
        INSERT INTO identity.password_reset_tokens (
          id,
          user_id,
          token_hash,
          expires_at
        )
        VALUES ($1, $2, $3, $4)
        RETURNING
          id,
          user_id,
          token_hash,
          created_at,
          expires_at,
          used_at
      `,
      [input.id, input.userId, input.tokenHash, input.expiresAt],
    );

    return mapReset(result.rows[0]);
  }

  async findPasswordResetTokenByHash(tokenHash: string) {
    const result = await db.query<ResetRow>(
      `
        SELECT
          id,
          user_id,
          token_hash,
          created_at,
          expires_at,
          used_at
        FROM identity.password_reset_tokens
        WHERE token_hash = $1
      `,
      [tokenHash],
    );

    return result.rows[0] ? mapReset(result.rows[0]) : null;
  }

  async markPasswordResetTokenUsed(tokenId: string, usedAt: Date) {
    await db.query(
      `
        UPDATE identity.password_reset_tokens
        SET used_at = $2
        WHERE id = $1
      `,
      [tokenId, usedAt],
    );
  }

  async invalidatePasswordResetTokensForUser(userId: string, at: Date) {
    await db.query(
      `
        UPDATE identity.password_reset_tokens
        SET used_at = $2
        WHERE user_id = $1
          AND used_at IS NULL
      `,
      [userId, at],
    );
  }
}

export { withTransaction };
