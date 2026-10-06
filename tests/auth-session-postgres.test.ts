import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import { LoginService } from '../src/auth/login.js';
import { PasswordService } from '../src/auth/password-service.js';
import { hashOpaqueToken } from '../src/auth/opaque-token.js';
import { hashPassword } from '../src/auth/passwords.js';
import { PostgresAuthStore } from '../src/auth/postgres-store.js';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import { resolveAuthContext } from '../src/auth/resolve-context.js';
import { SessionService } from '../src/auth/sessions.js';
import { db } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import { KODE_LEGACY_ROLE_KEYS, KODE_OPERATING_ROLE_KEYS } from '../src/organizations/role-model.js';

// Opt in only against a migrated disposable database. Connection failure is a failure.
test('persistent authentication sessions in real PostgreSQL', {
  skip: process.env.RUN_AUTH_SESSION_DB_TESTS !== 'true',
}, async (t) => {
  const organizationId = randomUUID();
  const users: string[] = [];
  const secret = 'integration-only-auth-session-secret-value';
  const password = 'integration-only-password-value';
  const origin = 'https://frontend.example.test';
  const lifetime = 7 * 24 * 60 * 60;
  const base = Date.now() + 60_000;
  let now = new Date(base);
  let contextFailure = false;
  const store = new PostgresAuthStore();
  const accessTokens = new AccessTokenService({
    secret, issuer: 'auth-session-test', audience: 'auth-session-api',
    ttlSeconds: 3600, clockToleranceSeconds: 0,
  });
  const makeSessions = () => new SessionService({
    store, accessTokens, tokenSecret: secret,
    accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: lifetime,
    resolveAuthContext: async (id) => {
      if (contextFailure) throw new Error('injected context lookup failure');
      return resolveAuthContext(id);
    },
    now: () => now, withTransaction,
  });
  const sessions = makeSessions();
  const auth = {
    verifier: accessTokens, resolveAuthContext,
    requireActiveSession: (sid: string, uid: string) => sessions.requireActiveSession(sid, uid),
  };
  const app = createApp({
    auth, corsOrigins: [origin], me: { loadPublicProfile: async () => null },
    authLifecycle: {
      auth, sessions, login: new LoginService({ store, sessions }),
      passwords: new PasswordService({
        store, sessions, tokenSecret: secret, passwordResetTtlSeconds: 1800,
        sendPasswordResetEmail: async () => {}, withTransaction,
      }),
      rateLimiter: new MemoryRateLimiter(['test']),
      cookies: { secure: true, refreshMaxAgeSeconds: lifetime },
    },
  });
  const seedUser = async (roleKey = 'admin') => {
    const id = randomUUID(); users.push(id);
    await db.query(`INSERT INTO identity.users (id,email,email_normalized,account_status)
      VALUES ($1,$2,$2,'active')`, [id, `${id}@example.test`]);
    await db.query(`INSERT INTO organizations.memberships (id,organization_id,user_id,role_key)
      VALUES ($1,$2,$3,$4)`, [randomUUID(), organizationId, id, roleKey]);
    return id;
  };
  const cookieRefresh = (token: string, bodyToken?: string) => app.request('/auth/refresh', {
    method: 'POST', headers: {
      Origin: origin, Cookie: `kode_refresh=${token}; kode_csrf=csrf-test-value`,
      'X-CSRF-Token': 'csrf-test-value', 'Content-Type': 'application/json',
    },
    body: JSON.stringify(bodyToken ? { refresh_token: bodyToken } : {}),
  });
  const assertCode = (code: string) => (err: unknown) => {
    assert.equal((err as { code: string }).code, code);
    return true;
  };
  try {
    await db.query(`INSERT INTO organizations.organizations (id,name,slug)
      VALUES ($1::uuid,'Auth sessions',$1::text)`, [organizationId]);

    await t.test('every operating and legacy role can restore a saved cookie after idle and overnight', async () => {
      const passwordHash = await hashPassword(password);
      for (const role of [...KODE_OPERATING_ROLE_KEYS, ...KODE_LEGACY_ROLE_KEYS]) {
        now = new Date(base);
        const user = await seedUser(role);
        await store.upsertPasswordHash(user, passwordHash);
        const login = await app.request('/auth/login', {
          method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: `${user}@example.test`, password }),
        });
        assert.equal(login.status, 200, role);
        const credentials = await login.json();
        const cookies = login.headers.get('set-cookie')!;
        assert.match(cookies, /kode_refresh=[^;]+;[^,]*HttpOnly/);
        assert.match(cookies, /Max-Age=604800/);
        assert.match(cookies, /Secure/);
        assert.match(cookies, /SameSite=None/i);
        const expiredAccess = await accessTokens.issue(user, {
          sessionId: credentials.session_id, expiresAt: new Date(Date.now() - 1000),
        });
        assert.equal((await app.request('/api/me', {
          headers: { Authorization: `Bearer ${expiredAccess}` },
        })).status, 401);

        now = new Date(base + 2 * 3600_000);
        const idle = await cookieRefresh(credentials.refresh_token);
        assert.equal(idle.status, 200, role);
        const idleCredentials = await idle.json();
        // A newly opened browser tab has no access token or body refresh token.
        now = new Date(base + 18 * 3600_000);
        const morning = await cookieRefresh(idleCredentials.refresh_token);
        assert.equal(morning.status, 200, role);
        const restored = await morning.json();
        const me = await app.request('/api/me', {
          headers: { Authorization: `Bearer ${restored.access_token}` },
        });
        assert.equal(me.status, 200, role);
        const identity = await me.json();
        assert.equal(identity.user.id, user);
        assert.equal(identity.membership.roleKey, role);
        assert.equal(restored.session_id, credentials.session_id);
      }
    });

    await t.test('refresh extends durable session expiry beyond the original login deadline', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      const originalExpiry = (await store.getSession(first.sessionId))!.expiresAt;
      now = new Date(base + 6 * 24 * 3600_000);
      const next = await sessions.rotateRefreshToken(first.refreshToken);
      assert.equal((await store.getSession(first.sessionId))!.expiresAt.getTime(), now.getTime() + lifetime * 1000);
      now = new Date(originalExpiry.getTime() + 3600_000);
      await makeSessions().rotateRefreshToken(next.refreshToken);
      await sessions.requireActiveSession(first.sessionId);
    });

    await t.test('a sleeping tab body token cannot override the newer shared cookie', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      const latest = await sessions.rotateRefreshToken(first.refreshToken);
      now = new Date(base + 3600_000); // Far beyond the concurrent reuse grace.
      const response = await cookieRefresh(latest.refreshToken, first.refreshToken);
      assert.equal(response.status, 200);
      assert.equal((await store.getSession(first.sessionId))!.revokedAt, null);
      const bodyOnly = await app.request('/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: (await response.json()).refresh_token }),
      });
      assert.equal(bodyOnly.status, 200); // Native/body-token clients still work.
    });

    await t.test('concurrent workers and a restarted service return one durable successor', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      const otherWorker = makeSessions();
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? sessions : otherWorker).rotateRefreshToken(first.refreshToken)));
      assert.equal(new Set(results.map((r) => r.refreshToken)).size, 1);
      const rows = await db.query(`SELECT count(*) AS total,count(*) FILTER (WHERE used_at IS NULL) AS active
        FROM identity.refresh_tokens WHERE session_id=$1`, [first.sessionId]);
      assert.equal(Number(rows.rows[0].total), 2);
      assert.equal(Number(rows.rows[0].active), 1);
      const retry = await makeSessions().rotateRefreshToken(first.refreshToken);
      assert.equal(retry.refreshToken, results[0]!.refreshToken);
      const newest = await otherWorker.rotateRefreshToken(retry.refreshToken);
      assert.equal((await makeSessions().rotateRefreshToken(first.refreshToken)).refreshToken, newest.refreshToken);
    });

    await t.test('replay outside grace commits revocation, including the successor', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      const next = await sessions.rotateRefreshToken(first.refreshToken);
      now = new Date(base + 31_000);
      await assert.rejects(() => sessions.rotateRefreshToken(first.refreshToken), assertCode('REFRESH_TOKEN_REPLAY'));
      assert.equal((await store.getSession(first.sessionId))!.revocationReason, 'refresh_token_replay');
      await assert.rejects(() => sessions.rotateRefreshToken(next.refreshToken), assertCode('SESSION_REVOKED'));
    });

    await t.test('legacy rotation races are retryable and never revoke a live session', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      const current = (await store.findRefreshTokenByHash(hashOpaqueToken(secret, first.refreshToken)))!;
      const legacyRaw = `legacy-successor-${randomUUID()}`;
      const replacementId = randomUUID();
      await withTransaction(async (client) => {
        await store.createRefreshToken({
          id: replacementId, sessionId: first.sessionId,
          tokenHash: hashOpaqueToken(secret, legacyRaw), expiresAt: current.expiresAt,
        }, client);
        await store.markRefreshTokenUsed(current.id, replacementId, now, client);
      });
      const response = await app.request('/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: first.refreshToken }),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'REFRESH_CONFLICT');
      assert.equal((await store.getSession(first.sessionId))!.revokedAt, null);
      assert.equal((await cookieRefresh(legacyRaw, first.refreshToken)).status, 200);
    });

    await t.test('cookie restoration still requires CSRF and does not fall back from an invalid cookie', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      const forbidden = await app.request('/auth/refresh', {
        method: 'POST', headers: {
          Origin: origin, Cookie: `kode_refresh=${first.refreshToken}; kode_csrf=csrf-test-value`,
          'Content-Type': 'application/json',
        }, body: '{}',
      });
      assert.equal(forbidden.status, 403);
      assert.equal((await forbidden.json()).error.code, 'CSRF_TOKEN_INVALID');
      const invalidCookie = await cookieRefresh('invalid-cookie-value', first.refreshToken);
      assert.equal(invalidCookie.status, 401);
      assert.equal((await invalidCookie.json()).error.code, 'INVALID_REFRESH_TOKEN');
      assert.equal((await store.findRefreshTokenByHash(hashOpaqueToken(secret, first.refreshToken)))!.usedAt, null);
    });

    await t.test('logout and suspension cannot be bypassed through concurrent reuse', async () => {
      now = new Date(base);
      const user = await seedUser();
      const first = await sessions.createAuthenticatedSession(user);
      await sessions.rotateRefreshToken(first.refreshToken);
      const logout = await app.request('/auth/logout', {
        method: 'POST', headers: { Authorization: `Bearer ${first.accessToken}` },
      });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
      await assert.rejects(() => makeSessions().rotateRefreshToken(first.refreshToken), assertCode('SESSION_REVOKED'));
      const suspended = await sessions.createAuthenticatedSession(user);
      await sessions.rotateRefreshToken(suspended.refreshToken);
      await db.query("UPDATE identity.users SET account_status='suspended' WHERE id=$1", [user]);
      await assert.rejects(() => makeSessions().rotateRefreshToken(suspended.refreshToken), assertCode('ACCOUNT_SUSPENDED'));
      assert.equal((await store.getSession(suspended.sessionId))!.revocationReason, 'account_suspended');
    });

    await t.test('a transient context failure does not consume the refresh token', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      contextFailure = true;
      try {
        await assert.rejects(() => sessions.rotateRefreshToken(first.refreshToken), /injected context lookup failure/);
      } finally { contextFailure = false; }
      assert.equal((await store.findRefreshTokenByHash(hashOpaqueToken(secret, first.refreshToken)))!.usedAt, null);
      await sessions.rotateRefreshToken(first.refreshToken);
    });

    await t.test('database failure rolls back successor, token consumption, and sliding expiry', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      const original = (await store.getSession(first.sessionId))!.expiresAt;
      const trigger = `auth_failure_${randomUUID().replaceAll('-', '')}`;
      await db.query(`CREATE FUNCTION identity.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN IF NEW.id='${first.sessionId}'::uuid THEN RAISE EXCEPTION 'injected session update failure'; END IF; RETURN NEW; END $f$`);
      await db.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON identity.sessions FOR EACH ROW EXECUTE FUNCTION identity.${trigger}()`);
      try {
        now = new Date(base + 3600_000);
        await assert.rejects(() => sessions.rotateRefreshToken(first.refreshToken), /injected session update failure/);
        assert.equal((await store.findRefreshTokenByHash(hashOpaqueToken(secret, first.refreshToken)))!.usedAt, null);
        assert.equal((await store.getSession(first.sessionId))!.expiresAt.getTime(), original.getTime());
        assert.equal(Number((await db.query('SELECT count(*) FROM identity.refresh_tokens WHERE session_id=$1', [first.sessionId])).rows[0].count), 1);
      } finally {
        await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON identity.sessions; DROP FUNCTION IF EXISTS identity.${trigger}()`);
      }
      await sessions.rotateRefreshToken(first.refreshToken);
    });

    await t.test('a session unattended beyond its lifetime cannot auto-login', async () => {
      now = new Date(base);
      const first = await sessions.createAuthenticatedSession(await seedUser());
      now = new Date(base + lifetime * 1000 + 1);
      await assert.rejects(() => sessions.rotateRefreshToken(first.refreshToken), assertCode('SESSION_REVOKED'));
    });
  } finally {
    await db.query('DELETE FROM identity.users WHERE id=ANY($1::uuid[])', [users]);
    await db.query('DELETE FROM organizations.organizations WHERE id=$1', [organizationId]);
    await db.end();
  }
});
