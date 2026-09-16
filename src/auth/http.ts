import type { Context } from 'hono';

export function requestMeta(c: Context) {
  const forwarded = c.req.header('x-forwarded-for');
  const ipAddress =
    forwarded?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    null;
  const userAgent = c.req.header('user-agent')?.slice(0, 512) || null;

  return {
    requestId: c.get('requestId'),
    ipAddress,
    userAgent,
  };
}

export function tokenResponse(issued: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  context: {
    actor: { userId: string; email: string | null };
    membership: { organizationId: string };
  };
}) {
  return {
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    session_id: issued.sessionId,
    user: {
      id: issued.context.actor.userId,
      email: issued.context.actor.email,
    },
    organization: {
      id: issued.context.membership.organizationId,
    },
  };
}
