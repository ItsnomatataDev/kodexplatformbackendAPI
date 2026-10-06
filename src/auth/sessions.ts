import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../db/transaction.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '../http/errors.js';
import type { AuthContext } from '../authorization/types.js';
import { assertAuthenticatedAccount } from './account.js';
import type { AccessTokenService } from './access-token.js';
import { publishAuthEvent } from './events.js';
import {
  deriveRefreshToken,
  generateOpaqueToken,
  hashOpaqueToken,
} from './opaque-token.js';
import type { AuthStore, RefreshTokenRecord, SessionRecord } from './store.js';

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
  /** Soft-reuse window for concurrent refreshes (multi-tab). Default 30s. */
  refreshTokenReuseGraceSeconds?: number;
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

  private reuseGraceMs() {
    const seconds = this.config.refreshTokenReuseGraceSeconds;
    if (seconds === 0) return 0;
    return (seconds ?? 30) * 1000;
  }

  private withinReuseGrace(token: RefreshTokenRecord, now: Date) {
    if (!token.usedAt) return false;
    const age = now.getTime() - token.usedAt.getTime();
    return this.reuseGraceMs() > 0 && age >= 0 && age <= this.reuseGraceMs();
  }

  private async recoverConcurrentRefresh(
    token: RefreshTokenRecord,
    rawToken: string,
    now: Date,
    client?: TransactionClient,
  ): Promise<string> {
    // Follow newer rotations too, so an out-of-order response does not restore
    // an already consumed successor. The session row remains locked throughout.
    for (let depth = 0; depth < 16; depth++) {
      if (!token.usedAt) {
        if (token.expiresAt <= now) {
          throw new UnauthorizedError(
            'EXPIRED_REFRESH_TOKEN',
            'The refresh token has expired.',
          );
        }
        return rawToken;
      }
      if (!this.withinReuseGrace(token, now) || !token.replacedBy) break;
      const nextRaw = deriveRefreshToken(
        this.config.tokenSecret, rawToken, token.replacedBy,
      );
      const next = await this.config.store.findRefreshTokenByHash(
        hashOpaqueToken(this.config.tokenSecret, nextRaw),
        client,
      );
      // Pre-release rotations used random successors. A retryable response keeps
      // the session intact while the browser retries with its current cookie.
      if (
        !next || next.id !== token.replacedBy ||
        next.sessionId !== token.sessionId
      ) break;
      token = next;
      rawToken = nextRaw;
    }
    throw new ConflictError(
      'REFRESH_CONFLICT',
      'Retry authentication with the current refresh cookie.',
    );
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

    const session = await this.requireActiveSession(current.sessionId);

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

    // Resolve account/membership before consuming a token. Transient context
    // failures must leave the existing credentials usable for a retry.
    const context = await this.config.resolveAuthContext(session.userId);
    assertAuthenticatedAccount(context);

    const result = await this.transaction(async (client) => {
      const locked = await this.config.store.getSession(session.id, client);
      const now = this.now();
      if (!locked || locked.revokedAt || locked.expiresAt <= now) {
        throw new UnauthorizedError(
          'SESSION_REVOKED', 'The session is no longer valid.',
        );
      }
      // Re-read after the lock: another tab/worker may already have rotated it.
      const token = await this.config.store.findRefreshTokenByHash(
        tokenHash, client,
      );
      if (!token || token.sessionId !== locked.id) {
        throw new UnauthorizedError(
          'INVALID_REFRESH_TOKEN', 'Authentication is required.',
        );
      }

      if (token.usedAt && !this.withinReuseGrace(token, now)) {
        await this.config.store.revokeSession(
          locked.id, 'refresh_token_replay', now, client,
        );
        // Return instead of throwing so the revocation is committed.
        return { replay: true as const };
      }

      let refreshToken: string;
      if (token.usedAt) {
        refreshToken = await this.recoverConcurrentRefresh(
          token, rawRefreshToken, now, client,
        );
      } else {
        if (token.expiresAt <= now) {
          throw new UnauthorizedError(
            'EXPIRED_REFRESH_TOKEN', 'The refresh token has expired.',
          );
        }
        const nextId = randomUUID();
        refreshToken = deriveRefreshToken(
          this.config.tokenSecret, rawRefreshToken, nextId,
        );
        const expiresAt = new Date(
          now.getTime() + this.config.refreshTokenTtlSeconds * 1000,
        );
        // Insert first to satisfy replaced_by's foreign key; all three writes
        // commit together, including the session's sliding expiry.
        await this.config.store.createRefreshToken(
          {
            id: nextId,
            sessionId: locked.id,
            tokenHash: hashOpaqueToken(this.config.tokenSecret, refreshToken),
            expiresAt,
          },
          client,
        );
        await this.config.store.markRefreshTokenUsed(
          token.id, nextId, now, client,
        );
        await this.config.store.touchSession(locked.id, now, expiresAt, client);
      }

      const accessToken = await this.config.accessTokens.issue(locked.userId, {
        sessionId: locked.id,
      });
      const issued: IssuedCredentials = {
        accessToken,
        refreshToken,
        expiresIn: this.config.accessTokenTtlSeconds,
        sessionId: locked.id,
        context,
      };
      return { replay: false as const, issued };
    });

    if (result.replay) {
      await publishAuthEvent('auth.session.revoked', {
        ...meta,
        userId: session.userId,
        sessionId: session.id,
        reason: 'refresh_token_replay',
      });
      await publishAuthEvent('auth.session.replay_detected', {
        ...meta,
        sessionId: session.id,
        reason: 'refresh_token_replay',
      });
      throw new UnauthorizedError(
        'REFRESH_TOKEN_REPLAY', 'Authentication is required.',
      );
    }

    await publishAuthEvent('auth.session.refresh', {
      ...meta,
      userId: session.userId,
      sessionId: session.id,
      organizationId: context.membership.organizationId,
    });
    return result.issued;
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
