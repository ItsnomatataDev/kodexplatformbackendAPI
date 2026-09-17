import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../db/transaction.js';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import type { AuthContext } from '../authorization/types.js';
import { assertAuthenticatedAccount } from './account.js';
import type { AccessTokenService } from './access-token.js';
import { publishAuthEvent } from './events.js';
import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.js';
import type { AuthStore, SessionRecord } from './store.js';

export type RequestMeta = {
  requestId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type SessionServiceConfig = {
  store: AuthStore;
  tokenSecret: string;
  accessTokens: AccessTokenService;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  resolveAuthContext: (userId: string) => Promise<AuthContext>;
  now?: () => Date;
  withTransaction?: <T>(
    work: (client?: TransactionClient) => Promise<T>,
  ) => Promise<T>;
};

export type IssuedCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  context: AuthContext;
};

export class SessionService {
  constructor(private readonly config: SessionServiceConfig) {}

  private now() {
    return this.config.now?.() ?? new Date();
  }

  private async transaction<T>(
    work: (client?: TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (this.config.withTransaction) {
      return this.config.withTransaction(work);
    }

    return work();
  }

  async createAuthenticatedSession(
    userId: string,
    meta: RequestMeta = {},
  ): Promise<IssuedCredentials> {
    const context = await this.config.resolveAuthContext(userId);
    assertAuthenticatedAccount(context);

    const now = this.now();
    const sessionExpiresAt = new Date(
      now.getTime() + this.config.refreshTokenTtlSeconds * 1000,
    );
    const refreshToken = generateOpaqueToken();
    const refreshTokenId = randomUUID();

    const session = await this.transaction(async (client) => {
      const created = await this.config.store.createSession(
        {
          userId,
          expiresAt: sessionExpiresAt,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        client,
      );

      await this.config.store.createRefreshToken(
        {
          id: refreshTokenId,
          sessionId: created.id,
          tokenHash: hashOpaqueToken(this.config.tokenSecret, refreshToken),
          expiresAt: sessionExpiresAt,
        },
        client,
      );

      return created;
    });

    const accessToken = await this.config.accessTokens.issue(userId, {
      sessionId: session.id,
    });

    await publishAuthEvent('auth.session.created', {
      requestId: meta.requestId,
      userId,
      sessionId: session.id,
      organizationId: context.membership.organizationId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.accessTokenTtlSeconds,
      sessionId: session.id,
      context,
    };
  }

  async revokeSession(
    sessionId: string,
    reason: string,
    meta: RequestMeta = {},
  ): Promise<boolean> {
    const session = await this.config.store.getSession(sessionId);
    const revoked = await this.config.store.revokeSession(
      sessionId,
      reason,
      this.now(),
    );

    if (revoked && session) {
      await publishAuthEvent('auth.session.revoked', {
        requestId: meta.requestId,
        userId: session.userId,
        sessionId,
        reason,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    }

    return revoked;
  }

  async revokeAllSessionsForUser(
    userId: string,
    reason: string,
    meta: RequestMeta = {},
    exceptSessionId?: string,
  ): Promise<number> {
    const count = await this.config.store.revokeAllSessionsForUser(
      userId,
      reason,
      this.now(),
      exceptSessionId,
    );

    if (count > 0) {
      await publishAuthEvent('auth.session.revoked', {
        requestId: meta.requestId,
        userId,
        reason,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    }

    return count;
  }

  async requireActiveSession(
    sessionId: string,
    userId?: string,
  ): Promise<SessionRecord> {
    const session = await this.config.store.getSession(sessionId);
    const now = this.now();

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      (userId != null && session.userId !== userId)
    ) {
      throw new UnauthorizedError(
        'SESSION_REVOKED',
        'The session is no longer valid.',
      );
    }

    return session;
  }

  async rotateRefreshToken(
    rawRefreshToken: string,
    meta: RequestMeta = {},
  ): Promise<IssuedCredentials> {
    const tokenHash = hashOpaqueToken(this.config.tokenSecret, rawRefreshToken);
    const current = await this.config.store.findRefreshTokenByHash(tokenHash);

    if (!current) {
      throw new UnauthorizedError(
        'INVALID_REFRESH_TOKEN',
        'Authentication is required.',
      );
    }

    if (current.usedAt) {
      await this.revokeSession(current.sessionId, 'refresh_token_replay', meta);
      await publishAuthEvent('auth.session.replay_detected', {
        requestId: meta.requestId,
        sessionId: current.sessionId,
        reason: 'refresh_token_replay',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedError(
        'REFRESH_TOKEN_REPLAY',
        'Authentication is required.',
      );
    }

    const now = this.now();

    if (current.expiresAt <= now) {
      throw new UnauthorizedError(
        'EXPIRED_REFRESH_TOKEN',
        'The refresh token has expired.',
      );
    }

    const session = await this.config.store.getSession(current.sessionId);

    if (!session || session.revokedAt || session.expiresAt <= now) {
      throw new UnauthorizedError(
        'SESSION_REVOKED',
        'The session is no longer valid.',
      );
    }

    const identity = await this.config.store.findLoginIdentityById(
      session.userId,
    );

    if (!identity) {
      await this.revokeSession(session.id, 'identity_not_found', meta);
      throw new UnauthorizedError(
        'IDENTITY_NOT_FOUND',
        'The authenticated identity is no longer valid.',
      );
    }

    if (
      !identity.isActive ||
      identity.deletedAt ||
      identity.accountStatus !== 'active'
    ) {
      const reason =
        identity.accountStatus === 'suspended'
          ? 'account_suspended'
          : 'account_inactive';
      await this.revokeAllSessionsForUser(session.userId, reason, meta);

      if (identity.accountStatus === 'suspended') {
        throw new ForbiddenError(
          'ACCOUNT_SUSPENDED',
          'The account is suspended.',
        );
      }

      throw new ForbiddenError(
        'ACCOUNT_INACTIVE',
        'The account is not active.',
      );
    }

    const nextRefreshToken = generateOpaqueToken();
    const nextRefreshTokenId = randomUUID();
    const sessionExpiresAt = new Date(
      now.getTime() + this.config.refreshTokenTtlSeconds * 1000,
    );

    await this.transaction(async (client) => {
      // Insert the replacement first so replaced_by can satisfy the FK.
      await this.config.store.createRefreshToken(
        {
          id: nextRefreshTokenId,
          sessionId: session.id,
          tokenHash: hashOpaqueToken(this.config.tokenSecret, nextRefreshToken),
          expiresAt: sessionExpiresAt,
        },
        client,
      );
      await this.config.store.markRefreshTokenUsed(
        current.id,
        nextRefreshTokenId,
        now,
        client,
      );
    });

    await this.config.store.touchSession(session.id, now);

    const context = await this.config.resolveAuthContext(session.userId);
    assertAuthenticatedAccount(context);

    const accessToken = await this.config.accessTokens.issue(session.userId, {
      sessionId: session.id,
    });

    await publishAuthEvent('auth.session.refresh', {
      requestId: meta.requestId,
      userId: session.userId,
      sessionId: session.id,
      organizationId: context.membership.organizationId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      accessToken,
      refreshToken: nextRefreshToken,
      expiresIn: this.config.accessTokenTtlSeconds,
      sessionId: session.id,
      context,
    };
  }
}

export function onAccountAccessRevoked(
  sessions: SessionService,
  userId: string,
  reason: 'account_suspended' | 'account_inactive' | 'account_deactivated',
  meta: RequestMeta = {},
) {
  return sessions.revokeAllSessionsForUser(userId, reason, meta);
}
