import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../db/transaction.js';
import { logger } from '../config/logger.js';
import { UnauthorizedError } from '../http/errors.js';
import { emailDomain, EmailDeliveryError } from './email.js';
import { publishAuthEvent } from './events.js';
import { hashPassword, validatePassword, verifyPassword } from './passwords.js';
import { normalizeEmail } from './login.js';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from './opaque-token.js';
import type { IssuedCredentials, RequestMeta, SessionService } from './sessions.js';
import type { AuthStore } from './store.js';

export type PasswordServiceConfig = {
  store: AuthStore;
  sessions: SessionService;
  tokenSecret: string;
  passwordResetTtlSeconds: number;
  sendPasswordResetEmail: (input: {
    to: string;
    resetToken: string;
    firstName?: string;
    expiresMinutes: number;
  }) => Promise<void>;
  resolveFirstName?: (userId: string, email: string) => Promise<string | null>;
  withTransaction?: <T>(
    work: (client?: TransactionClient) => Promise<T>,
  ) => Promise<T>;
};

export class PasswordService {
  constructor(private readonly config: PasswordServiceConfig) {}

  private async transaction<T>(
    work: (client?: TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (this.config.withTransaction) {
      return this.config.withTransaction(work);
    }

    return work();
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta = {},
  ): Promise<IssuedCredentials> {
    const identity = await this.config.store.findLoginIdentityById(userId);

    if (!identity?.passwordHash) {
      throw new UnauthorizedError(
        'INVALID_CREDENTIALS',
        'Incorrect email or password.',
      );
    }

    const matches = await verifyPassword(identity.passwordHash, currentPassword);

    if (!matches) {
      throw new UnauthorizedError(
        'INVALID_CREDENTIALS',
        'Incorrect email or password.',
      );
    }

    validatePassword(newPassword, identity.email);
    const passwordHash = await hashPassword(newPassword);
    await this.config.store.upsertPasswordHash(userId, passwordHash);
    await this.config.sessions.revokeAllSessionsForUser(
      userId,
      'password_changed',
      meta,
    );

    const issued = await this.config.sessions.createAuthenticatedSession(
      userId,
      meta,
    );

    await publishAuthEvent('auth.password.changed', {
      requestId: meta.requestId,
      userId,
      sessionId: issued.sessionId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return issued;
  }

  async requestPasswordReset(
    email: string,
    meta: RequestMeta = {},
  ): Promise<void> {
    const identity = await this.config.store.findLoginIdentityByEmail(
      normalizeEmail(email),
    );

    await publishAuthEvent('auth.password.reset.requested', {
      requestId: meta.requestId,
      userId: identity?.userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    if (!identity || !identity.email) {
      return;
    }

    const resetToken = generateOpaqueToken();
    const tokenId = randomUUID();
    const now = new Date();

    // Mint first — do NOT invalidate prior tokens until email succeeds,
    // so a failed send never strands someone who still had a valid link.
    await this.config.store.createPasswordResetToken({
      id: tokenId,
      userId: identity.userId,
      tokenHash: hashOpaqueToken(this.config.tokenSecret, resetToken),
      expiresAt: new Date(
        Date.now() + this.config.passwordResetTtlSeconds * 1000,
      ),
    });

    const expiresMinutes = Math.max(
      1,
      Math.round(this.config.passwordResetTtlSeconds / 60),
    );
    const resolvedFirstName = this.config.resolveFirstName
      ? await this.config.resolveFirstName(identity.userId, identity.email)
      : null;

    try {
      await this.config.sendPasswordResetEmail({
        to: identity.email,
        resetToken,
        firstName: resolvedFirstName ?? undefined,
        expiresMinutes,
      });
    } catch (error) {
      // Burn the undelivered token so it cannot be used later.
      await this.config.store.markPasswordResetTokenUsed(tokenId, new Date());
      if (!(error instanceof EmailDeliveryError)) {
        logger.warn(
          {
            template: 'password_reset',
            toDomain: emailDomain(identity.email),
            err: error instanceof Error ? error.message : String(error),
          },
          'Password reset email delivery failed.',
        );
      }
      throw error instanceof EmailDeliveryError
        ? error
        : new EmailDeliveryError(error);
    }

    // Email delivered — retire any older unused tokens for this user.
    await this.config.store.invalidatePasswordResetTokensForUser(
      identity.userId,
      now,
      undefined,
      tokenId,
    );
  }

  async confirmPasswordReset(
    resetToken: string,
    newPassword: string,
    meta: RequestMeta = {},
  ): Promise<void> {
    const tokenHash = hashOpaqueToken(this.config.tokenSecret, resetToken);
    const record = await this.config.store.findPasswordResetTokenByHash(
      tokenHash,
    );

    if (!record || record.usedAt) {
      throw new UnauthorizedError(
        'INVALID_RESET_TOKEN',
        'The password reset token is not valid.',
      );
    }

    if (record.expiresAt <= new Date()) {
      throw new UnauthorizedError(
        'EXPIRED_RESET_TOKEN',
        'The password reset token has expired.',
      );
    }

    const identity = await this.config.store.findLoginIdentityById(
      record.userId,
    );

    validatePassword(newPassword, identity?.email ?? null);
    const passwordHash = await hashPassword(newPassword);
    const usedAt = new Date();

    await this.transaction(async (client) => {
      const consumed = await this.config.store.consumePasswordResetToken(
        record.id,
        usedAt,
        client,
      );
      if (!consumed) {
        throw new UnauthorizedError(
          'INVALID_RESET_TOKEN',
          'The password reset token is not valid.',
        );
      }

      await this.config.store.upsertPasswordHash(
        record.userId,
        passwordHash,
        client,
      );
      await this.config.store.invalidatePasswordResetTokensForUser(
        record.userId,
        usedAt,
        client,
        record.id,
      );
    });

    await this.config.sessions.revokeAllSessionsForUser(
      record.userId,
      'password_reset',
      meta,
    );

    await publishAuthEvent('auth.password.reset.completed', {
      requestId: meta.requestId,
      userId: record.userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }
}
