import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthContext } from '../authorization/types.js';
import { UnauthorizedError } from '../http/errors.js';
import { assertAuthenticatedAccount, rejectClientUserOverride } from './account.js';
import { extractBearerToken } from './credential.js';
import type { CredentialVerifier } from './verifier.js';

export type AuthDependencies = {
  verifier: CredentialVerifier;
  resolveAuthContext: (userId: string) => Promise<AuthContext>;
  requireActiveSession: (sessionId: string, userId: string) => Promise<unknown>;
};

export function createAuthMiddleware(dependencies: AuthDependencies) {
  return createMiddleware(async (c, next) => {
    const extracted = extractBearerToken(c.req.header('authorization'));

    if (!extracted.ok) {
      throw new UnauthorizedError(extracted.code, extracted.message);
    }

    const verified = await dependencies.verifier.verify(extracted.token);

    if (!verified.sessionId) {
      throw new UnauthorizedError(
        'SESSION_REQUIRED',
        'A valid session is required.',
      );
    }

    await dependencies.requireActiveSession(verified.sessionId, verified.userId);
    const context = await dependencies.resolveAuthContext(verified.userId);

    assertAuthenticatedAccount(context);
    rejectClientUserOverride(context, c.req.header('x-user-id'));

    c.set('auth', context);
    c.set('sessionId', verified.sessionId);

    const requestLogger = c.get('logger');
    requestLogger.info(
      {
        userId: context.actor.userId,
        organizationId: context.membership.organizationId,
      },
      'authenticated',
    );

    await next();
  });
}

export function getAuth(c: Context): AuthContext {
  const auth = c.get('auth');

  if (!auth) {
    throw new UnauthorizedError();
  }

  return auth;
}

export function getSessionId(c: Context): string | undefined {
  return c.get('sessionId');
}
