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
  }) => Promise<void>;
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
        'Authentication failed.',
      );
    }

    const matches = await verifyPassword(identity.passwordHash, currentPassword);

    if (!matches) {
      throw new UnauthorizedError(
        'INVALID_CREDENTIALS',
        'Authentication failed.',
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
    const now = new Date();
    await this.transaction(async (client) => {
      await this.config.store.invalidatePasswordResetTokensForUser(
        identity.userId,
        now,
        client,
      );
      await this.config.store.createPasswordResetToken(
        {
          id: randomUUID(),
          userId: identity.userId,
          tokenHash: hashOpaqueToken(this.config.tokenSecret, resetToken),
          expiresAt: new Date(
            Date.now() + this.config.passwordResetTtlSeconds * 1000,
          ),
        },
        client,
      );
    });

    try {
      await this.config.sendPasswordResetEmail({
        to: identity.email,
        resetToken,
      });
    } catch (error) {
      if (!(error instanceof EmailDeliveryError)) {
        logger.warn(
          {
            template: 'password_reset',
            toDomain: emailDomain(identity.email),
          },
          'Password reset email delivery failed.',
        );
      }
    }
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
    await this.config.store.upsertPasswordHash(record.userId, passwordHash);
    await this.config.store.markPasswordResetTokenUsed(record.id, new Date());
    await this.config.store.invalidatePasswordResetTokensForUser(
      record.userId,
      new Date(),
    );
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
