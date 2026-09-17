import { randomUUID } from 'node:crypto';
import type { AccessTokenService } from '../src/auth/access-token.js';
import { UnauthorizedError } from '../src/http/errors.js';

type TestSession = {
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
};

export function createSessionAuth(tokenService: AccessTokenService) {
  const sessions = new Map<string, TestSession>();

  return {
    async issueBearer(
      userId: string,
      options: { sessionId?: string; expiresAt?: Date } = {},
    ) {
      const sessionId = options.sessionId ?? randomUUID();
      sessions.set(sessionId, {
        userId,
        revokedAt: null,
        expiresAt: options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const token = await tokenService.issue(userId, {
        sessionId,
        expiresAt: options.expiresAt,
      });
      return {
        authorization: `Bearer ${token}`,
        token,
        sessionId,
      };
    },
    async requireActiveSession(sessionId: string, userId: string) {
      const session = sessions.get(sessionId);
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt <= new Date() ||
        session.userId !== userId
      ) {
        throw new UnauthorizedError(
          'SESSION_REVOKED',
          'The session is no longer valid.',
        );
      }
    },
    revoke(sessionId: string) {
      const session = sessions.get(sessionId);
      if (session) {
        session.revokedAt = new Date();
      }
    },
  };
}
