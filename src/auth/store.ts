import type { AccountStatus } from '../authorization/types.js';
import type { TransactionClient } from '../db/transaction.js';

export type LoginIdentity = {
  userId: string;
  email: string | null;
  emailNormalized: string | null;
  isActive: boolean;
  accountStatus: AccountStatus;
  deletedAt: Date | null;
  passwordHash: string | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

export type RefreshTokenRecord = {
  id: string;
  sessionId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  replacedBy: string | null;
};

export type PasswordResetRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
};

export type CreateSessionInput = {
  userId: string;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type CreateRefreshTokenInput = {
  id: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
};

export type AuthStore = {
  findLoginIdentityByEmail(
    emailNormalized: string,
  ): Promise<LoginIdentity | null>;
  findLoginIdentityById(userId: string): Promise<LoginIdentity | null>;
  upsertPasswordHash(
    userId: string,
    passwordHash: string,
    client?: TransactionClient,
  ): Promise<void>;
  createSession(
    input: CreateSessionInput,
    client?: TransactionClient,
  ): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listActiveSessions(userId: string): Promise<SessionRecord[]>;
  touchSession(sessionId: string, at: Date): Promise<void>;
  revokeSession(
    sessionId: string,
    reason: string,
    at: Date,
    client?: TransactionClient,
  ): Promise<boolean>;
  revokeAllSessionsForUser(
    userId: string,
    reason: string,
    at: Date,
    exceptSessionId?: string,
  ): Promise<number>;
  createRefreshToken(
    input: CreateRefreshTokenInput,
    client?: TransactionClient,
  ): Promise<RefreshTokenRecord>;
  findRefreshTokenByHash(
    tokenHash: string,
  ): Promise<RefreshTokenRecord | null>;
  markRefreshTokenUsed(
    tokenId: string,
    replacedBy: string,
    usedAt: Date,
    client?: TransactionClient,
  ): Promise<void>;
  createPasswordResetToken(
    input: Omit<PasswordResetRecord, 'usedAt' | 'createdAt'> & {
      createdAt?: Date;
    },
    client?: TransactionClient,
  ): Promise<PasswordResetRecord>;
  findPasswordResetTokenByHash(
    tokenHash: string,
  ): Promise<PasswordResetRecord | null>;
  markPasswordResetTokenUsed(tokenId: string, usedAt: Date): Promise<void>;
  invalidatePasswordResetTokensForUser(
    userId: string,
    at: Date,
    client?: TransactionClient,
  ): Promise<void>;
};
