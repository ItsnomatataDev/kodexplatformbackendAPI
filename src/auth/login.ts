import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { publishAuthEvent } from './events.js';
import { hashPassword, verifyPassword } from './passwords.js';
import type { SessionService, IssuedCredentials, RequestMeta } from './sessions.js';
import type { AuthStore } from './store.js';
import { recordSecurityEvent } from '../security/recorder.js';
import { db } from '../db/pool.js';

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

const GENERIC_FAILURE = 'Incorrect email or password.';

async function resolveOrgForUser(userId: string | undefined) {
  if (!userId) return null;
  try {
    const result = await db.query(
      `SELECT organization_id
       FROM organizations.memberships
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId],
    );
    return (result.rows[0]?.organization_id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

async function recordLoginSecurityEvent(input: {
  organizationId?: string | null;
  userId?: string;
  success: boolean;
  failureCategory?: string;
  meta: RequestMeta;
}) {
  if (!input.organizationId) return;
  try {
    await recordSecurityEvent({
      organizationId: input.organizationId,
      eventType: input.success ? 'AUTH_SUCCESS' : 'AUTH_FAILURE',
      severity: input.success ? 'info' : 'medium',
      riskScore: input.success ? 0 : 40,
      successful: input.success,
      userId: input.userId ?? null,
      ipAddress: input.meta.ipAddress ?? null,
      userAgent: input.meta.userAgent ?? null,
      requestMethod: 'POST',
      endpoint: '/auth/login',
      httpStatus: input.success ? 200 : 401,
      requestId: input.meta.requestId ?? null,
      attackCategory: input.success ? null : 'authentication',
      metadata: {
        failureCategory: input.failureCategory ?? null,
      },
    });
  } catch {
    // Security recording must never block authentication.
  }
}

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
      const orgId = await resolveOrgForUser(identity?.userId);
      await recordLoginSecurityEvent({
        organizationId: orgId,
        userId: identity?.userId,
        success: false,
        failureCategory: identity ? 'invalid_password' : 'unknown_account',
        meta,
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
    await recordLoginSecurityEvent({
      organizationId: issued.context.membership.organizationId,
      userId: identity.userId,
      success: true,
      meta,
    });

    return issued;
  }
}
