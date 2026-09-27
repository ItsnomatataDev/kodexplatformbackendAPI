import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import { scrubSecurityMetadata } from '../src/security/recorder.js';
import { hasPermission } from '../src/authorization/permissions.js';
import type { AuthContext } from '../src/authorization/types.js';

const userA = '11111111-1111-1111-1111-111111111111';
const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const secret = 'test-only-access-token-secret-value!!';

function baseContext(overrides: Partial<AuthContext['membership']> = {}): AuthContext {
  return {
    actor: {
      userId: userA,
      email: 'user@example.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId: orgA,
      officeId: null,
      roleId: 'role-1',
      roleKey: 'member',
      status: 'active',
      isAdminRole: false,
      isManagerRole: false,
      permissions: {},
      ...overrides,
    },
    organization: {
      organizationId: orgA,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

test('scrubSecurityMetadata redacts passwords and tokens', () => {
  const scrubbed = scrubSecurityMetadata({
    email: 'user@example.com',
    password: 'secret-password',
    refresh_token: 'rt_live',
    access_token: 'at_live',
    nested: {
      api_key: 'k_live',
      note: 'safe',
    },
    csrf_token: 'csrf',
  });

  assert.equal(scrubbed.email, 'user@example.com');
  assert.equal(scrubbed.password, '[redacted]');
  assert.equal(scrubbed.refresh_token, '[redacted]');
  assert.equal(scrubbed.access_token, '[redacted]');
  assert.equal(scrubbed.csrf_token, '[redacted]');
  assert.equal((scrubbed.nested as Record<string, unknown>).api_key, '[redacted]');
  assert.equal((scrubbed.nested as Record<string, unknown>).note, 'safe');
});

test('security permission nesting supports least-privilege keys', () => {
  const permissions = {
    security: {
      view: true,
      investigate: true,
      contain: false,
    },
  };

  assert.equal(hasPermission(permissions, 'security.view'), true);
  assert.equal(hasPermission(permissions, 'security.investigate'), true);
  assert.equal(hasPermission(permissions, 'security.contain'), false);
  assert.equal(hasPermission(permissions, 'security.manage'), false);
});

test('security wildcard grants nested view', () => {
  assert.equal(
    hasPermission({ security: { '*': true } }, 'security.view'),
    true,
  );
});

test('unauthenticated control-center requests are denied', async () => {
  const tokens = new AccessTokenService({
    secret,
    issuer: 'kode-platform/development',
    audience: 'kode-platform-api/development',
    ttlSeconds: 900,
  });
  const app = createApp({
    auth: {
      verifier: tokens,
      resolveAuthContext: async () => baseContext(),
      requireActiveSession: async () => undefined,
    },
  });

  const response = await app.request('/api/security/control-center');
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, 'MISSING_CREDENTIAL');
});

test('authenticated member without security permission is forbidden', async () => {
  const tokens = new AccessTokenService({
    secret,
    issuer: 'kode-platform/development',
    audience: 'kode-platform-api/development',
    ttlSeconds: 900,
  });
  const token = await tokens.issue(userA, {
    sessionId: '22222222-2222-2222-2222-222222222222',
  });

  const app = createApp({
    auth: {
      verifier: tokens,
      resolveAuthContext: async () => baseContext({ roleKey: 'member' }),
      requireActiveSession: async () => undefined,
    },
  });

  const response = await app.request('/api/security/control-center', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error?: { code?: string } };
  assert.ok(
    body.error?.code === 'SECURITY_PERMISSION_REQUIRED' ||
      body.error?.code === 'SECURITY_ADMIN_REQUIRED',
  );
});

test('behavioral event type patterns match expected client event names', async () => {
  const { eventTypeMatches } = await import('../src/security/detection.js');
  assert.equal(
    eventTypeMatches('AUTH_FAILURE', ['AUTH_FAILURE', '%failed_login%']),
    true,
  );
  assert.equal(
    eventTypeMatches('user_failed_login', ['AUTH_FAILURE', '%failed_login%']),
    true,
  );
  assert.equal(
    eventTypeMatches('HONEYPOT_INTERACTION', ['HONEYPOT_INTERACTION', '%honeypot%']),
    true,
  );
  assert.equal(
    eventTypeMatches('AUTH_SUCCESS', ['AUTH_FAILURE', '%failed_login%']),
    false,
  );
});
