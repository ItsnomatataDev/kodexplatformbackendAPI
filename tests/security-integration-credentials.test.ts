import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import type { AuthContext } from '../src/authorization/types.js';
import { env } from '../src/config/env.js';
import { verifyIntegrationCredential } from '../src/security/integration-credentials.js';

const userA = '11111111-1111-4111-8111-111111111111';
const orgA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const orgB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const secret = 'test-only-access-token-secret-value!!';
const sessionId = '22222222-2222-4222-8222-222222222222';

function context(organizationId: string, permissions: unknown): AuthContext {
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
      organizationId,
      officeId: null,
      roleId: 'role-1',
      roleKey: 'member',
      status: 'active',
      isAdminRole: false,
      isManagerRole: false,
      permissions,
    },
    organization: {
      organizationId,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

function appFor(permissions: unknown, organizationId = orgA) {
  const issuer = new AccessTokenService({
    secret,
    issuer: 'kode-platform/development',
    audience: 'kode-platform-api/development',
    ttlSeconds: 900,
  });
  return {
    issuer,
    app: createApp({
      auth: {
        verifier: issuer,
        resolveAuthContext: async () => context(organizationId, permissions),
        requireActiveSession: async () => undefined,
      },
    }),
  };
}

test('credential issue requires authentication', async () => {
  const { app } = appFor({ security: { manage_configuration: true } });
  const response = await app.request(
    `/api/security/projects/${randomUUID()}/integrations/${randomUUID()}/credentials`,
    { method: 'POST' },
  );
  assert.equal(response.status, 401);
});

test('credential issue rejects a member without manage_configuration', async () => {
  const { app, issuer } = appFor({ security: { view: true } });
  const token = await issuer.issue(userA, { sessionId });
  const response = await app.request(
    `/api/security/projects/${randomUUID()}/integrations/${randomUUID()}/credentials`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
  assert.equal(response.status, 403);
});

test('integration credential lifecycle', async (t) => {
  const pool = new Pool({
    host: env.database.host,
    port: env.database.port,
    database: env.database.name,
    user: env.database.user,
    password: env.database.password,
    max: 2,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end().catch(() => undefined);
    t.skip('PostgreSQL is not available');
    return;
  }
  const table = await pool.query(
    `SELECT to_regclass('security.integration_credentials') AS name`,
  );
  if (!table.rows[0]?.name) {
    await pool.end();
    t.skip('security.integration_credentials is not migrated');
    return;
  }

  const slug = `cred-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO identity.users (id, email, email_normalized, account_status)
     VALUES ($1, $2, $2, 'active') ON CONFLICT (id) DO NOTHING`,
    [userA, `cred-${userA.slice(0, 8)}@example.com`],
  );
  for (const [id, name] of [
    [orgA, `${slug}-a`],
    [orgB, `${slug}-b`],
  ] as const) {
    await pool.query(
      `INSERT INTO organizations.organizations (id, name, slug)
       VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`,
      [id, name],
    );
  }

  const manage = appFor({
    security: { view: true, manage_assets: true, manage_configuration: true },
  });
  const token = await manage.issuer.issue(userA, { sessionId });
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const project = await manage.app.request('/api/security/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Credential project', slug }),
  });
  assert.equal(project.status, 201);
  const projectId = ((await project.json()) as { project: { id: string } }).project.id;
  const integration = await manage.app.request(
    `/api/security/projects/${projectId}/integrations`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'API connector',
        slug: `${slug}-api`,
        integration_type: 'api',
        credential_ref: 'env:CONNECTOR',
      }),
    },
  );
  assert.equal(integration.status, 201);
  const integrationId = (
    (await integration.json()) as { integration: { id: string } }
  ).integration.id;

  const otherOrg = appFor(
    { security: { manage_configuration: true, view: true } },
    orgB,
  );
  const tokenB = await otherOrg.issuer.issue(userA, { sessionId });
  const foreignIssue = await otherOrg.app.request(
    `/api/security/projects/${projectId}/integrations/${integrationId}/credentials`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
  assert.equal(foreignIssue.status, 404);

  const issued = await manage.app.request(
    `/api/security/projects/${projectId}/integrations/${integrationId}/credentials`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ expires_in_days: 7 }),
    },
  );
  assert.equal(issued.status, 201);
  const issuedBody = (await issued.json()) as {
    credential_id: string;
    credential: string;
    expires_at: string;
    scope: string;
    secret_hash?: string;
  };
  assert.match(issuedBody.credential, /^kint_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]+$/);
  assert.equal(issuedBody.scope, 'events:write');
  assert.equal(issuedBody.secret_hash, undefined);
  assert.ok(new Date(issuedBody.expires_at).getTime() > Date.now());

  const rotated = await manage.app.request(
    `/api/security/projects/${projectId}/integrations/${integrationId}/credentials`,
    { method: 'POST', headers, body: JSON.stringify({}) },
  );
  assert.equal(rotated.status, 201);
  const rotatedBody = (await rotated.json()) as { credential: string };
  assert.notEqual(rotatedBody.credential, issuedBody.credential);

  const listed = await manage.app.request(
    `/api/security/projects/${projectId}/integrations/${integrationId}/credentials`,
    { headers },
  );
  assert.equal(listed.status, 200);
  const listedText = await listed.text();
  assert.equal(listedText.includes(issuedBody.credential), false);
  assert.equal(listedText.includes('secret_hash'), false);
  assert.equal(listedText.includes('credential_hash'), false);

  const verified = await verifyIntegrationCredential(issuedBody.credential);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.context.organizationId, orgA);
    assert.equal(verified.context.integrationId, integrationId);
    assert.equal(verified.context.projectId, projectId);
  }
  assert.equal((await verifyIntegrationCredential('kint_not-a-real-key_secret')).ok, false);
  assert.equal(
    (await verifyIntegrationCredential(`${issuedBody.credential}tampered`)).ok,
    false,
  );

  const audit = await pool.query(
    `SELECT resulting_state::text AS state
     FROM security.audit_log
     WHERE organization_id = $1 AND action = 'credential.issue'`,
    [orgA],
  );
  const auditText = audit.rows.map((row) => row.state).join('\n');
  assert.equal(auditText.includes(issuedBody.credential), false);
  assert.equal(auditText.includes('secret_hash'), false);

  await pool.query(
    `UPDATE security.integration_credentials
     SET expires_at = NOW() - INTERVAL '1 minute'
     WHERE id = $1`,
    [issuedBody.credential_id],
  );
  assert.equal((await verifyIntegrationCredential(issuedBody.credential)).ok, false);
  await pool.query(
    `UPDATE security.integration_credentials
     SET expires_at = NOW() + INTERVAL '1 day'
     WHERE id = $1`,
    [issuedBody.credential_id],
  );

  const revoked = await manage.app.request(
    `/api/security/projects/${projectId}/integrations/${integrationId}/credentials/${issuedBody.credential_id}/revoke`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'rotation test' }),
    },
  );
  assert.equal(revoked.status, 200);
  const stillThere = await pool.query(
    `SELECT revoked_at FROM security.integration_credentials WHERE id = $1`,
    [issuedBody.credential_id],
  );
  assert.ok(stillThere.rows[0]?.revoked_at);
  assert.equal((await verifyIntegrationCredential(issuedBody.credential)).ok, false);

  const foreignRevoke = await otherOrg.app.request(
    `/api/security/projects/${projectId}/integrations/${integrationId}/credentials/${issuedBody.credential_id}/revoke`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'cross tenant' }),
    },
  );
  assert.equal(foreignRevoke.status, 404);

  await pool.query(
    `UPDATE security.integrations SET status = 'paused'
     WHERE id = $1`,
    [integrationId],
  );
  assert.equal((await verifyIntegrationCredential(rotatedBody.credential)).ok, false);
  await pool.query(
    `UPDATE security.integrations SET status = 'revoked' WHERE id = $1`,
    [integrationId],
  );
  assert.equal((await verifyIntegrationCredential(rotatedBody.credential)).ok, false);

  await pool.query(
    `DELETE FROM security.audit_log WHERE organization_id = $1 AND resource_type = 'security.integration_credential'`,
    [orgA],
  );
  await pool.query(
    `DELETE FROM security.integration_credentials WHERE organization_id = $1`,
    [orgA],
  );
  await pool.query(`DELETE FROM security.integrations WHERE organization_id = $1`, [orgA]);
  await pool.query(`DELETE FROM security.projects WHERE id = $1`, [projectId]);
  await pool.end();
});
