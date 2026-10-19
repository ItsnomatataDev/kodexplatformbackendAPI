import { IngressLimiter } from './auth/ingress.js';
import { checkDatabaseRole } from './db/pool.js';
import { isIP } from 'node:net';
import { Hono, type Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { InfrastructureConfig } from './config.js';
import { InfrastructureAuth, InfraError } from './auth/service.js';
import { digest, equal } from './crypto/secrets.js';
import { validateInfrastructurePassword } from './auth/passwords.js';

type InfrastructureEnv = {
  Variables: { requestId: string };
  Bindings: { incoming?: IncomingMessage };
};
type InfrastructureContext = Context<InfrastructureEnv>;
export function createInfrastructureApp(
  config: InfrastructureConfig,
  pool: pg.Pool,
) {
  const auth = new InfrastructureAuth(pool, config);
  const ingress = new IngressLimiter();
  const app = new Hono<InfrastructureEnv>();
  const prefix = '/infrastructure-api';
  const names = {
    session: config.secure
      ? '__Host-kodex_infra_session'
      : 'kodex_infra_dev_session',
    challenge: config.secure
      ? '__Host-kodex_infra_challenge'
      : 'kodex_infra_dev_challenge',
  };
  const cookieOptions = {
    httpOnly: true,
    secure: config.secure,
    sameSite: 'Strict' as const,
    path: '/',
  };
  app.use('*', secureHeaders());
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    c.header('Cache-Control', 'no-store');
    c.header('X-Request-ID', c.get('requestId'));
    await next();
  });
  const meta = (c: InfrastructureContext) => {
    const peer = c.env?.incoming?.socket?.remoteAddress ?? 'local';
    const forwarded = c.req.header('X-Infra-Client-IP') ?? '';
    const ip =
      config.trustedProxyIps?.includes(peer) && isIP(forwarded)
        ? forwarded
        : peer;
    return { requestId: c.get('requestId') as string, actor: `http:${ip}` };
  };
  // Before body parsing, Origin/CSRF, or any database lookup.
  app.use(`${prefix}/*`, async (c, next) => {
    const gate = ingress.enter(meta(c).actor, config.now().getTime());
    if (!gate.allowed) {
      if (gate.report) {
        try {
          await auth.denied(meta(c), 'ingress_limited');
        } catch {
          return c.json({ error: 'Authentication service unavailable' }, 503);
        }
      }
      c.header('Retry-After', '60');
      return c.json({ error: 'Try again later' }, 429);
    }
    try {
      await next();
    } finally {
      gate.release();
    }
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 8192,
      onError: (c) => c.json({ error: 'Request too large' }, 413),
    }),
  );
  // Same-origin reverse proxy contract: no broad CORS and no trust in client-supplied forwarding headers.
  app.use(`${prefix}/*`, async (c, next) => {
    if (c.req.method !== 'GET') {
      if (c.req.header('Origin') !== config.origin)
        throw new InfraError(403, 'Invalid request origin');
      const context = await auth.context(
        getCookie(c, names.session),
        getCookie(c, names.challenge),
      );
      if (
        !context ||
        !equal(
          c.req.header('X-CSRF-Token') ?? '',
          digest(config, 'csrf', context.token),
        )
      )
        throw new InfraError(403, 'Invalid CSRF token');
      if (c.req.header('Content-Type')?.split(';')[0] !== 'application/json')
        throw new InfraError(400, 'JSON required');
    }
    await next();
  });
  const challenge = (c: InfrastructureContext) =>
    getCookie(c, names.challenge) ?? '';
  const setChallenge = (c: InfrastructureContext, token: string) => {
    deleteCookie(c, names.session, cookieOptions);
    setCookie(c, names.challenge, token, {
      ...cookieOptions,
      maxAge: config.challengeSeconds,
    });
  };
  const setSession = (c: InfrastructureContext, token: string) => {
    deleteCookie(c, names.challenge, cookieOptions);
    setCookie(c, names.session, token, {
      ...cookieOptions,
      maxAge: config.absoluteSeconds,
    });
  };
  const body = async (
    c: InfrastructureContext,
  ): Promise<Record<string, string>> => {
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      throw new InfraError(400, 'Invalid request');
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some((v) => typeof v !== 'string' || v.length > 1024)
    )
      throw new InfraError(400, 'Invalid request');
    return value as Record<string, string>;
  };
  const principal = async (c: InfrastructureContext, permission?: string) => {
    const p = await auth.session(getCookie(c, names.session) ?? '');
    if (!p) throw new InfraError();
    if (permission && !p.permissions.includes(permission))
      throw new InfraError(403, 'Permission denied');
    return p;
  };
  const throttle = async (c: InfrastructureContext, accountKey?: string) => {
    const identity = await auth.throttleIdentity(
      getCookie(c, names.session) ?? '',
      challenge(c),
    );
    return auth.limit(
      [
        { key: `ip:${meta(c).actor}`, limit: 100 },
        ...(accountKey
          ? [{ key: `account:${accountKey.trim().toLowerCase()}`, limit: 10 }]
          : []),
        ...(identity ? [{ key: `identity:${identity}`, limit: 30 }] : []),
        ...(challenge(c)
          ? [{ key: `challenge:${challenge(c)}`, limit: 8 }]
          : []),
      ],
      meta(c),
    );
  };
  app.get('/health/live', (c) =>
    c.json({ service: 'kodex-infrastructure', status: 'ok' }),
  );
  app.get('/health/ready', async (c) => {
    const gate = ingress.enter('health:ready', config.now().getTime());
    if (!gate.allowed) return c.json({ error: 'Readiness limited' }, 503);
    try {
      await auth.ready();
      await checkDatabaseRole(pool, 'kode_infra_runtime');
      await pool
        .query(
          `SELECT (SELECT count(*) FROM infrastructure.accounts WHERE false),
      (SELECT count(*) FROM infrastructure.sessions WHERE false),
      (SELECT count(*) FROM infrastructure.auth_challenges WHERE false),
      (SELECT count(*) FROM infrastructure.bootstrap_tokens WHERE false),
      (SELECT count(*) FROM infrastructure.mfa_credentials WHERE false),
      (SELECT count(*) FROM infrastructure.recovery_codes WHERE false),
      (SELECT count(*) FROM infrastructure.authentication_attempts WHERE false),
      (SELECT count(*) FROM infrastructure.account_permissions WHERE false),
      (SELECT count(*) FROM infrastructure.servers WHERE false),
      has_table_privilege(current_user,'infrastructure.audit_events','INSERT') AS audit,
      has_function_privilege(current_user,'infrastructure.record_denial(text,text,uuid,uuid)','EXECUTE') AS limiter`,
        )
        .then((r) => {
          if (!r.rows[0].audit || !r.rows[0].limiter)
            throw new Error('Dependency unavailable');
        });
      return c.json({ status: 'ready' });
    } finally {
      gate.release();
    }
  });
  app.get(`${prefix}/auth/csrf`, async (c) => {
    let context = await auth.context(
      getCookie(c, names.session),
      getCookie(c, names.challenge),
    );
    if (!context) {
      await throttle(c);
      const token = await auth.browser();
      setChallenge(c, token);
      context = { token, kind: 'challenge' };
    }
    return c.json({ csrfToken: digest(config, 'csrf', context.token) });
  });
  app.get(`${prefix}/auth/challenge`, async (c) =>
    c.json({ stage: await auth.stage(challenge(c)) }),
  );
  app.post(`${prefix}/auth/login`, async (c) => {
    const b = await body(c);
    await throttle(c, b.login ?? '');
    const token = await auth.login(
      b.login ?? '',
      b.password ?? '',
      challenge(c),
      meta(c),
    );
    setChallenge(c, token);
    return c.json({ next: 'verify' });
  });
  app.post(`${prefix}/auth/bootstrap/redeem`, async (c) => {
    const b = await body(c);
    await throttle(c);
    setChallenge(
      c,
      await auth.redeem(b.capability ?? '', challenge(c), meta(c)),
    );
    return c.json({ next: 'enroll' });
  });
  app.post(`${prefix}/auth/enrollment/start`, async (c) => {
    const b = await body(c);
    await throttle(c);
    try {
      validateInfrastructurePassword(b.password);
    } catch {
      throw new InfraError(400, 'Password must contain 15–128 characters');
    }
    return c.json(
      await auth.enrollmentStart(challenge(c), b.password, meta(c)),
    );
  });
  app.post(`${prefix}/auth/enrollment/confirm`, async (c) => {
    const b = await body(c);
    await throttle(c);
    const result = await auth.enrollmentConfirm(
      challenge(c),
      b.otp ?? '',
      meta(c),
    );
    deleteCookie(c, names.challenge, cookieOptions);
    return c.json(result);
  });
  app.post(`${prefix}/auth/mfa/verify`, async (c) => {
    const b = await body(c);
    await throttle(c);
    setSession(c, await auth.mfa(challenge(c), b.otp ?? '', meta(c)));
    return c.json({ next: 'dashboard' });
  });
  app.post(`${prefix}/auth/recovery/verify`, async (c) => {
    const b = await body(c);
    await throttle(c);
    setChallenge(c, await auth.recovery(challenge(c), b.code ?? '', meta(c)));
    return c.json({ next: 'enroll' });
  });
  app.get(`${prefix}/auth/session`, async (c) => {
    const p = await principal(c);
    return c.json({
      account: {
        id: p.account_id,
        login: p.login,
        displayName: p.display_name,
      },
      permissions: p.permissions,
      mfaVerified: true,
      expiresAt: p.expires_at,
      idleExpiresAt: new Date(
        p.last_activity_at.getTime() + config.idleSeconds * 1000,
      ),
      freshUntil: new Date(
        p.authenticated_at.getTime() + config.freshSeconds * 1000,
      ),
    });
  });
  for (const action of [
    'logout',
    'logout-all',
    'reauthenticate',
    'activity',
  ] as const)
    app.post(`${prefix}/auth/${action}`, async (c) => {
      const b = await body(c);
      if (action === 'reauthenticate') await throttle(c);
      const next = await auth.sessionAction(
        getCookie(c, names.session) ?? '',
        action,
        meta(c),
        b.password ?? '',
        b.otp ?? '',
      );
      if (next) setSession(c, next);
      if (action.startsWith('logout'))
        deleteCookie(c, names.session, cookieOptions);
      return c.json({ ok: true });
    });
  app.post(`${prefix}/auth/mfa/replace`, async (c) => {
    const b = await body(c);
    await throttle(c);
    const token = await auth.sessionAction(
      getCookie(c, names.session) ?? '',
      'mfa-replace',
      meta(c),
      b.password ?? '',
      b.otp ?? '',
    );
    setChallenge(c, token!);
    return c.json({ next: 'enroll' });
  });
  app.get(`${prefix}/dashboard`, async (c) => {
    const p = await principal(c, 'infra.dashboard.read');
    return c.json({
      administrator: p.display_name,
      agentStatus: 'Not connected / Phase 1',
      operationalModulesAvailable: false,
    });
  });
  app.get(`${prefix}/servers`, async (c) => {
    const p = await principal(c, 'infra.servers.read');
    const r = await pool.query(
      'SELECT id,label,display_address AS "displayAddress" FROM infrastructure.servers WHERE organization_id=$1 ORDER BY label LIMIT 100',
      [p.organization_id],
    );
    return c.json({ servers: r.rows });
  });
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError(async (error, c) => {
    const known = error instanceof InfraError;
    try {
      await auth.denied(
        meta(c),
        known
          ? error.status === 429
            ? 'throttled'
            : error.status === 403
              ? 'forbidden'
              : 'invalid_authentication'
          : 'service_unavailable',
        await auth.denialIdentity(
          getCookie(c, names.session) ?? '',
          challenge(c),
        ),
      );
    } catch {
      return c.json({ error: 'Authentication service unavailable' }, 503);
    }
    // Never serialize errors, request bodies, cookies, QR material or credentials.
    return c.json(
      { error: known ? error.code : 'Authentication service unavailable' },
      known ? error.status : 503,
    );
  });
  return app;
}
