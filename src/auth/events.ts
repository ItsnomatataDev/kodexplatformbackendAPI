import { createDomainEvent } from '../events/types.js';
import { publishDomainEvent } from '../events/publisher.js';

export type AuthEventName =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'auth.logout_all'
  | 'auth.session.created'
  | 'auth.session.revoked'
  | 'auth.session.refresh'
  | 'auth.session.replay_detected'
  | 'auth.password.changed'
  | 'auth.password.reset.requested'
  | 'auth.password.reset.completed';

export type AuthEventInput = {
  requestId?: string;
  userId?: string;
  sessionId?: string;
  organizationId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  reason?: string;
  failureCategory?: string;
};

export async function publishAuthEvent(
  name: AuthEventName,
  input: AuthEventInput = {},
): Promise<void> {
  await publishDomainEvent(
    createDomainEvent(name, {
      actorId: input.userId,
      organizationId: input.organizationId,
      resourceType: input.sessionId ? 'identity.session' : 'identity.user',
      resourceId: input.sessionId ?? input.userId,
      payload: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        reason: input.reason,
        failureCategory: input.failureCategory,
        ipAddress: input.ipAddress ?? undefined,
        userAgent: input.userAgent ?? undefined,
      },
    }),
  );
}
