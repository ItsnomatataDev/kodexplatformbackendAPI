import { Hono } from 'hono';
import { getLimitedBodyText } from '../middleware/body-limit.js';
import { ValidationError } from '../http/errors.js';
import { createAuthMiddleware, getAuth, getSessionId } from './middleware.js';
import type { AuthDependencies } from './middleware.js';
import { rejectClientUserOverride } from './account.js';
import { rejectClientOrganizationOverride } from '../authorization/organization.js';
import { LoginService } from './login.js';
import { PasswordService } from './password-service.js';
import { SessionService } from './sessions.js';
import {
  clearAuthCookies,
  readRefreshToken,
  setAuthCookies,
  type CookieSettings,
} from './cookies.js';
import { requestMeta, tokenResponse } from './http.js';
import { enforceRateLimit, type RateLimiter } from './rate-limit.js';
import { publishAuthEvent } from './events.js';
import { generateOpaqueToken } from './opaque-token.js';
import { setCookie } from 'hono/cookie';
import { CSRF_COOKIE } from './cookies.js';

export type AuthRouteDependencies = {
  auth: AuthDependencies;
  login: LoginService;
  sessions: SessionService;
  passwords: PasswordService;
  rateLimiter: RateLimiter;
  cookies: CookieSettings;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function readJson(c: {
  req: { json: () => Promise<unknown> };
  get: (key: 'limitedBodyText') => string | undefined;
}) {
  try {
    const raw = getLimitedBodyText(c);
    const parsed =
      raw === undefined
        ? await c.req.json()
        : raw.length === 0
          ? {}
          : JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createAuthRoutes(dependencies: AuthRouteDependencies) {
  const routes = new Hono();
  const authenticate = createAuthMiddleware(dependencies.auth);

  routes.get('/csrf', (c) => {
    const token = generateOpaqueToken();
    setCookie(c, CSRF_COOKIE, token, {
      httpOnly: false,
      secure: dependencies.cookies.secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: dependencies.cookies.refreshMaxAgeSeconds,
    });
    return c.json({ csrf_token: token });
  });

  routes.post('/login', async (c) => {
    const meta = requestMeta(c);
    await enforceRateLimit(
      dependencies.rateLimiter,
      `login:ip:${meta.ipAddress ?? 'unknown'}`,
      10,
      900,
    );

    const body = await readJson(c);
    const email = readString(body.email);
    const password = readString(body.password);

    if (!email || !password) {
      throw new ValidationError('Email and password are required.');
    }

    await enforceRateLimit(
      dependencies.rateLimiter,
      `login:email:${email.trim().toLowerCase()}`,
      5,
      900,
    );

    const issued = await dependencies.login.login(email, password, meta);
    setAuthCookies(c, issued.refreshToken, dependencies.cookies);
    return c.json(tokenResponse(issued));
  });

  routes.post('/refresh', async (c) => {
    const meta = requestMeta(c);
    await enforceRateLimit(
      dependencies.rateLimiter,
      `refresh:ip:${meta.ipAddress ?? 'unknown'}`,
      30,
      900,
    );

    const body = await readJson(c);
    const refreshToken = readRefreshToken(c, readString(body.refresh_token));

    if (!refreshToken) {
      throw new ValidationError('A refresh token is required.');
    }

    const issued = await dependencies.sessions.rotateRefreshToken(
      refreshToken,
      meta,
    );
    setAuthCookies(c, issued.refreshToken, dependencies.cookies);
    return c.json(tokenResponse(issued));
  });

  routes.post('/logout', authenticate, async (c) => {
    const auth = getAuth(c);
    rejectClientUserOverride(auth, c.req.header('x-user-id'));
    const sessionId = getSessionId(c);
    const meta = requestMeta(c);

    if (sessionId) {
      await dependencies.sessions.revokeSession(sessionId, 'logout', meta);
    }

    await publishAuthEvent('auth.logout', {
      requestId: meta.requestId,
      userId: auth.actor.userId,
      sessionId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    clearAuthCookies(c, dependencies.cookies);
    return c.json({ revoked: Boolean(sessionId) });
  });

  routes.post('/logout-all', authenticate, async (c) => {
    const auth = getAuth(c);
    rejectClientUserOverride(
      auth,
      c.req.query('user_id') ?? c.req.header('x-user-id'),
    );
    const meta = requestMeta(c);
    const count = await dependencies.sessions.revokeAllSessionsForUser(
      auth.actor.userId,
      'logout_all',
      meta,
    );

    await publishAuthEvent('auth.logout_all', {
      requestId: meta.requestId,
      userId: auth.actor.userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    clearAuthCookies(c, dependencies.cookies);
    return c.json({ revoked: count });
  });

  routes.post('/password/change', authenticate, async (c) => {
    const auth = getAuth(c);
    rejectClientUserOverride(
      auth,
      c.req.query('user_id') ?? c.req.header('x-user-id'),
    );
    rejectClientOrganizationOverride(
      auth,
      c.req.query('organization_id') ?? c.req.header('x-organization-id'),
    );

    const body = await readJson(c);
    const currentPassword = readString(body.current_password);
    const newPassword = readString(body.new_password);

    if (!currentPassword || !newPassword) {
      throw new ValidationError(
        'Current password and new password are required.',
      );
    }

    const issued = await dependencies.passwords.changePassword(
      auth.actor.userId,
      currentPassword,
      newPassword,
      requestMeta(c),
    );
    setAuthCookies(c, issued.refreshToken, dependencies.cookies);
    return c.json(tokenResponse(issued));
  });

  routes.post('/password/reset/request', async (c) => {
    const meta = requestMeta(c);
    await enforceRateLimit(
      dependencies.rateLimiter,
      `reset-request:ip:${meta.ipAddress ?? 'unknown'}`,
      5,
      900,
    );

    const body = await readJson(c);
    const email = readString(body.email);

    if (!email) {
      throw new ValidationError('Email is required.');
    }

    await enforceRateLimit(
      dependencies.rateLimiter,
      `reset-request:email:${email.trim().toLowerCase()}`,
      3,
      900,
    );

    await dependencies.passwords.requestPasswordReset(email, meta);
    return c.json({
      message: 'If the account exists, password reset instructions will be sent.',
    });
  });

  routes.post('/password/reset/confirm', async (c) => {
    const meta = requestMeta(c);
    await enforceRateLimit(
      dependencies.rateLimiter,
      `reset-confirm:ip:${meta.ipAddress ?? 'unknown'}`,
      10,
      900,
    );

    const body = await readJson(c);
    const token = readString(body.token);
    const newPassword = readString(body.new_password);

    if (!token || !newPassword) {
      throw new ValidationError('Reset token and new password are required.');
    }

    await dependencies.passwords.confirmPasswordReset(token, newPassword, meta);
    return c.json({ reset: true });
  });

  return routes;
}
