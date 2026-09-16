import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../db/transaction.js';
import type {
  AuthStore,
  CreateRefreshTokenInput,
  CreateSessionInput,
  LoginIdentity,
  PasswordResetRecord,
  RefreshTokenRecord,
  SessionRecord,
} from './store.js';

type MemoryUser = LoginIdentity;

export class MemoryAuthStore implements AuthStore {
  private readonly usersById = new Map<string, MemoryUser>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly resetTokens = new Map<string, PasswordResetRecord>();

  seedUser(user: MemoryUser) {
    this.usersById.set(user.userId, { ...user });

    if (user.emailNormalized) {
      this.usersByEmail.set(user.emailNormalized, user.userId);
    }
  }

  async findLoginIdentityByEmail(emailNormalized: string) {
    const userId = this.usersByEmail.get(emailNormalized);
    return userId ? this.cloneUser(userId) : null;
  }

  async findLoginIdentityById(userId: string) {
    return this.cloneUser(userId);
  }

  async upsertPasswordHash(userId: string, passwordHash: string) {
    const user = this.usersById.get(userId);

    if (!user) {
      throw new Error('Cannot store a password for an unknown user.');
    }

    user.passwordHash = passwordHash;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date();
    const session: SessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      createdAt: now,
      expiresAt: input.expiresAt,
      lastSeenAt: now,
      revokedAt: null,
      revocationReason: null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    };

    this.sessions.set(session.id, session);
    return { ...session };
  }

  async getSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  async listActiveSessions(userId: string) {
    const now = new Date();

    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.userId === userId &&
          session.revokedAt == null &&
          session.expiresAt > now,
      )
      .map((session) => ({ ...session }));
  }

  async touchSession(sessionId: string, at: Date) {
    const session = this.sessions.get(sessionId);

    if (session) {
      session.lastSeenAt = at;
    }
  }

  async revokeSession(sessionId: string, reason: string, at: Date) {
    const session = this.sessions.get(sessionId);

    if (!session || session.revokedAt) {
      return false;
    }

    session.revokedAt = at;
    session.revocationReason = reason;
    return true;
  }

  async revokeAllSessionsForUser(
    userId: string,
    reason: string,
    at: Date,
    exceptSessionId?: string,
  ) {
    let count = 0;

    for (const session of this.sessions.values()) {
      if (
        session.userId === userId &&
        session.revokedAt == null &&
        session.id !== exceptSessionId
      ) {
        session.revokedAt = at;
        session.revocationReason = reason;
        count += 1;
      }
    }

    return count;
  }

  async createRefreshToken(
    input: CreateRefreshTokenInput,
  ): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = {
      id: input.id,
      sessionId: input.sessionId,
      tokenHash: input.tokenHash,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      usedAt: null,
      replacedBy: null,
    };

    this.refreshTokens.set(record.tokenHash, record);
    return { ...record };
  }

  async findRefreshTokenByHash(tokenHash: string) {
    const record = this.refreshTokens.get(tokenHash);
    return record ? { ...record } : null;
  }

  async markRefreshTokenUsed(
    tokenId: string,
    replacedBy: string,
    usedAt: Date,
  ) {
    for (const record of this.refreshTokens.values()) {
      if (record.id === tokenId) {
        record.usedAt = usedAt;
        record.replacedBy = replacedBy;
      }
    }
  }

  async createPasswordResetToken(
    input: Omit<PasswordResetRecord, 'usedAt' | 'createdAt'> & {
      createdAt?: Date;
    },
  ) {
    const record: PasswordResetRecord = {
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      createdAt: input.createdAt ?? new Date(),
      expiresAt: input.expiresAt,
      usedAt: null,
    };

    this.resetTokens.set(record.tokenHash, record);
    return { ...record };
  }

  async findPasswordResetTokenByHash(tokenHash: string) {
    const record = this.resetTokens.get(tokenHash);
    return record ? { ...record } : null;
  }

  async markPasswordResetTokenUsed(tokenId: string, usedAt: Date) {
    for (const record of this.resetTokens.values()) {
      if (record.id === tokenId) {
        record.usedAt = usedAt;
      }
    }
  }

  async invalidatePasswordResetTokensForUser(userId: string, at: Date) {
    for (const record of this.resetTokens.values()) {
      if (record.userId === userId && record.usedAt == null) {
        record.usedAt = at;
      }
    }
  }

  expireRefreshToken(tokenHash: string, at: Date) {
    const record = this.refreshTokens.get(tokenHash);
    if (record) {
      record.expiresAt = at;
    }
  }

  expirePasswordResetToken(tokenHash: string, at: Date) {
    const record = this.resetTokens.get(tokenHash);
    if (record) {
      record.expiresAt = at;
    }
  }

  private cloneUser(userId: string): LoginIdentity | null {
    const user = this.usersById.get(userId);
    return user ? { ...user } : null;
  }
}

export type { TransactionClient };
