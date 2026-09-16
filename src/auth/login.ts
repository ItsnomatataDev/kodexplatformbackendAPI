import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { publishAuthEvent } from './events.js';
import { hashPassword, verifyPassword } from './passwords.js';
import type { SessionService, IssuedCredentials, RequestMeta } from './sessions.js';
import type { AuthStore } from './store.js';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

let dummyHashPromise: Promise<string> | undefined;

function dummyPasswordHash() {
  dummyHashPromise ??= hashPassword(
    'kode-platform-dummy-password-not-a-real-account',
  );
  return dummyHashPromise;
}

export type LoginServiceConfig = {
  store: AuthStore;
  sessions: SessionService;
};

const GENERIC_FAILURE = 'Authentication failed.';

export class LoginService {
  constructor(private readonly config: LoginServiceConfig) {}

  async login(
    email: string,
    password: string,
    meta: RequestMeta = {},
  ): Promise<IssuedCredentials> {
    const emailNormalized = normalizeEmail(email);
    const identity = await this.config.store.findLoginIdentityByEmail(
      emailNormalized,
    );

    const passwordHash = identity?.passwordHash ?? (await dummyPasswordHash());
    const passwordMatches = await verifyPassword(passwordHash, password);

    if (!identity || !identity.passwordHash || !passwordMatches) {
      await publishAuthEvent('auth.login.failure', {
        requestId: meta.requestId,
        userId: identity?.userId,
        failureCategory: identity ? 'invalid_password' : 'unknown_account',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedError('INVALID_CREDENTIALS', GENERIC_FAILURE);
    }

    if (
      !identity.isActive ||
      identity.deletedAt ||
      identity.accountStatus === 'deleted'
    ) {
      await publishAuthEvent('auth.login.failure', {
        requestId: meta.requestId,
        userId: identity.userId,
        failureCategory: 'account_inactive',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new ForbiddenError(
        'ACCOUNT_INACTIVE',
        'The account is not active.',
      );
    }

    if (identity.accountStatus === 'suspended') {
      await publishAuthEvent('auth.login.failure', {
        requestId: meta.requestId,
        userId: identity.userId,
        failureCategory: 'account_suspended',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new ForbiddenError(
        'ACCOUNT_SUSPENDED',
        'The account is suspended.',
      );
    }

    if (identity.accountStatus !== 'active') {
      await publishAuthEvent('auth.login.failure', {
        requestId: meta.requestId,
        userId: identity.userId,
        failureCategory: 'account_not_active',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new ForbiddenError(
        'ACCOUNT_NOT_ACTIVE',
        'The account is not approved for access.',
      );
    }

    const issued = await this.config.sessions.createAuthenticatedSession(
      identity.userId,
      meta,
    );

    await publishAuthEvent('auth.login.success', {
      requestId: meta.requestId,
      userId: identity.userId,
      sessionId: issued.sessionId,
      organizationId: issued.context.membership.organizationId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return issued;
  }
}
