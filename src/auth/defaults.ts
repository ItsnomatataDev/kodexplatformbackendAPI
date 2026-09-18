import { env } from '../config/env.js';
import { withTransaction } from '../db/transaction.js';
import { AccessTokenService } from './access-token.js';
import { resolveAuthContext } from './resolve-context.js';
import { loadPublicProfile, updatePublicProfile } from './public-profile.js';
import type { AuthDependencies } from './middleware.js';
import type { MeRouteDependencies } from '../routes/me.js';
import type { AuthRouteDependencies } from './routes.js';
import { PostgresAuthStore } from './postgres-store.js';
import { SessionService } from './sessions.js';
import { LoginService } from './login.js';
import { PasswordService } from './password-service.js';
import { createEmailSender } from './email.js';
import { MemoryRateLimiter } from './rate-limit.js';
import { RedisRateLimiter } from './rate-limit-redis.js';

export function createDefaultAccessTokenService() {
  return new AccessTokenService({
    secret: env.auth.tokenSecret,
    issuer: env.auth.issuer,
    audience: env.auth.audience,
    ttlSeconds: env.auth.accessTokenTtlSeconds,
  });
}

export function createDefaultAuthDependencies(): AuthDependencies {
  const store = new PostgresAuthStore();
  const sessions = new SessionService({
    store,
    tokenSecret: env.auth.tokenSecret,
    accessTokens: createDefaultAccessTokenService(),
    accessTokenTtlSeconds: env.auth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: env.auth.refreshTokenTtlSeconds,
    resolveAuthContext,
    withTransaction,
  });

  return {
    verifier: createDefaultAccessTokenService(),
    resolveAuthContext,
    requireActiveSession: (sessionId, userId) =>
      sessions.requireActiveSession(sessionId, userId),
  };
}

export function createDefaultMeDependencies(): MeRouteDependencies {
  return {
    loadPublicProfile,
    updatePublicProfile,
  };
}

export function createDefaultAuthLifecycle(
  auth: AuthDependencies = createDefaultAuthDependencies(),
): AuthRouteDependencies {
  const store = new PostgresAuthStore();
  const accessTokens = createDefaultAccessTokenService();
  const sessions = new SessionService({
    store,
    tokenSecret: env.auth.tokenSecret,
    accessTokens,
    accessTokenTtlSeconds: env.auth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: env.auth.refreshTokenTtlSeconds,
    resolveAuthContext: auth.resolveAuthContext,
    withTransaction,
  });

  const emailSender = createEmailSender(env.email);

  return {
    auth,
    login: new LoginService({ store, sessions }),
    sessions,
    passwords: new PasswordService({
      store,
      sessions,
      tokenSecret: env.auth.tokenSecret,
      passwordResetTtlSeconds: env.auth.passwordResetTtlSeconds,
      sendPasswordResetEmail: (message) =>
        emailSender.sendPasswordReset(message),
      withTransaction,
    }),
    rateLimiter:
      env.appEnv === 'development'
        ? new MemoryRateLimiter(['development'])
        : new RedisRateLimiter({
            appEnv: env.appEnv,
            host: env.redis.host,
            port: env.redis.port,
            username: env.redis.username,
            password: env.redis.password,
            tls: env.redis.tls,
            rejectUnauthorized: env.redis.rejectUnauthorized,
            ca: env.redis.ca,
          }),
    cookies: {
      secure: env.auth.cookieSecure,
      refreshMaxAgeSeconds: env.auth.refreshTokenTtlSeconds,
    },
  };
}
