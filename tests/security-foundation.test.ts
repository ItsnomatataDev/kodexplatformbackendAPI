import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import type { AuthContext } from '../src/authorization/types.js';
import { env } from '../src/config/env.js';

const userA = '11111111-1111-4111-8111-111111111111';
const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secret = 'test-only-access-token-secret-value!!';

function context(organizationId: string, permissions: unknown, roleKey = 'member'): AuthContext {
  return {
    actor: {
      userId: userA,
      email: 'user@itsnomatata.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId,
      officeId: null,
      roleId: 'role-1',
      roleKey,
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

function tokens() {
  return new AccessTokenService({
    secret,
    issuer: 'kode-platform/development',
    audience: 'kode-platform-api/development',
    ttlSeconds: 900,
  });
}

function appFor(authContext: AuthContext) {
  const issuer = tokens();
  return {
    issuer,
    app: createApp({
      auth: {
        verifier: issuer,
        resolveAuthContext: async () => authContext,
        requireActiveSession: async () => undefined,
      },
    }),
  };
}

test('security project list requires authentication', async () => {
  const { app } = appFor(context(orgA, {}));
  const response = await app.request('/api/security/projects');
  assert.equal(response.status, 401);
});

test('security project list rejects a member without security.view', async () => {
  const { app, issuer } = appFor(context(orgA, {}));
  const token = await issuer.issue(userA, {
    sessionId: '22222222-2222-4222-8222-222222222222',
  });
  const response = await app.request('/api/security/projects', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 403);
});

test('client organization id cannot authorize a project write', async () => {
  const { app, issuer } = appFor(
    context(orgA, { security: { manage_assets: true } }),
  );
  const token = await issuer.issue(userA, {
    sessionId: '22222222-2222-4222-8222-222222222222',
  });
  const response = await app.request('/api/security/projects', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Client override',
      slug: 'client-override',
      organization_id: orgB,
    }),
  });
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');
});

test('integration create rejects a plaintext secret', async () => {
  const { app, issuer } = appFor(
    context(orgA, { security: { manage_configuration: true } }),
  );
  const token = await issuer.issue(userA, {
    sessionId: '22222222-2222-4222-8222-222222222222',
  });
  const response = await app.request(
    `/api/security/projects/${randomUUID()}/integrations`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Harold',
        slug: 'harold',
        integration_type: 'api',
        secret: 'super-secret-value',
      }),
    },
  );
  assert.equal(response.status, 400);
});

test('view permission cannot create an integration', async () => {
  const { app, issuer } = appFor(context(orgA, { security: { view: true } }));
  const token = await issuer.issue(userA, {
    sessionId: '22222222-2222-4222-8222-222222222222',
  });
  const response = await app.request(
    `/api/security/projects/${randomUUID()}/integrations`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Harold',
        slug: 'harold',
        integration_type: 'api',
        credential_ref: 'env:HAROLD_INGEST',
      }),
    },
  );
  assert.equal(response.status, 403);
});

test('security foundation tenant lifecycle', async (t) => {
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
    `SELECT to_regclass('security.integrations') AS name`,
  );
  if (!table.rows[0]?.name) {
    await pool.end();
    t.skip('security.integrations is not migrated');
    return;
  }

  const slugA = `p02a-${randomUUID().slice(0, 8)}`;
  const slugB = `p02b-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO identity.users (id, email, email_normalized, account_status)
     VALUES ($1, $2, $2, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [userA, `p02a-${userA.slice(0, 8)}@example.com`],
  );
  for (const [id, slug] of [
    [orgA, slugA],
    [orgB, slugB],
  ] as const) {
    await pool.query(
      `INSERT INTO organizations.organizations (id, name, slug)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, slug, slug],
    );
  }

  const sessionId = '22222222-2222-4222-8222-222222222222';
  const { app, issuer } = appFor(
    context(orgA, {
      security: { view: true, manage_assets: true, manage_configuration: true },
    }),
  );
  const token = await issuer.issue(userA, { sessionId });
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };

  const created = await app.request('/api/security/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'ITs No Matata Production',
      slug: slugA,
      environment: 'production',
      description: 'Foundation test',
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    project: { id: string; organization_id: string };
  };
  const projectId = createdBody.project.id;
  assert.equal(createdBody.project.organization_id, orgA);

  const duplicate = await app.request('/api/security/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Again', slug: slugA }),
  });
  assert.equal(duplicate.status, 409);

  const invalid = await app.request('/api/security/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Bad', slug: `${slugA}-bad`, environment: 'moon' }),
  });
  assert.equal(invalid.status, 400);

  const { app: appB, issuer: issuerB } = appFor(
    context(orgB, { security: { view: true, manage_assets: true } }),
  );
  const tokenB = await issuerB.issue(userA, { sessionId });
  const foreign = await appB.request(`/api/security/projects/${projectId}`, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(foreign.status, 404);

  const asset = await app.request(`/api/security/projects/${projectId}/assets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Production API',
      slug: `${slugA}-api`,
      asset_type: 'api',
    }),
  });
  assert.equal(asset.status, 201);
  const assetBody = (await asset.json()) as { asset: { id: string } };

  const wrongProject = await app.request(
    `/api/security/projects/${randomUUID()}/assets`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Orphan', slug: `${slugA}-orphan`, asset_type: 'api' }),
    },
  );
  assert.equal(wrongProject.status, 404);

  const integration = await app.request(
    `/api/security/projects/${projectId}/integrations`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Harold connector',
        slug: `${slugA}-harold`,
        integration_type: 'api',
        credential_ref: 'env:HAROLD_INGEST',
      }),
    },
  );
  assert.equal(integration.status, 201);
  const integrationBody = (await integration.json()) as {
    integration: { id: string; credential_ref: string | null };
  };
  assert.equal(integrationBody.integration.credential_ref, 'env:HAROLD_INGEST');
  assert.equal(
    JSON.stringify(integrationBody).includes('super-secret'),
    false,
  );

  const revoked = await app.request(
    `/api/security/projects/${projectId}/integrations/${integrationBody.integration.id}/revoke`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Foundation test revoke' }),
    },
  );
  assert.equal(revoked.status, 200);
  const revokedBody = (await revoked.json()) as {
    integration: { status: string; credential_ref: string | null };
  };
  assert.equal(revokedBody.integration.status, 'revoked');
  assert.equal(revokedBody.integration.credential_ref, null);

  const audit = await pool.query(
    `SELECT action, resulting_state::text AS state
     FROM security.audit_log
     WHERE organization_id = $1 AND resource_id = $2`,
    [orgA, integrationBody.integration.id],
  );
  const serialized = audit.rows.map((row) => `${row.action} ${row.state}`).join('\n');
  assert.match(serialized, /integration.create/);
  assert.match(serialized, /integration.revoke/);
  assert.equal(serialized.includes('env:HAROLD_INGEST'), false);
  assert.equal(serialized.includes('super-secret'), false);

  const retired = await app.request(
    `/api/security/projects/${projectId}/assets/${assetBody.asset.id}`,
    { method: 'DELETE', headers },
  );
  assert.equal(retired.status, 200);

  const projectRetired = await app.request(`/api/security/projects/${projectId}`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(projectRetired.status, 200);

  await pool.query(`DELETE FROM security.audit_log WHERE organization_id = ANY($1::uuid[])`, [
    [orgA, orgB],
  ]);
  await pool.query(
    `DELETE FROM security.integration_credentials WHERE organization_id = ANY($1::uuid[])`,
    [[orgA, orgB]],
  );
  await pool.query(`DELETE FROM security.integrations WHERE organization_id = ANY($1::uuid[])`, [
    [orgA, orgB],
  ]);
  await pool.query(`DELETE FROM security.assets WHERE organization_id = ANY($1::uuid[])`, [
    [orgA, orgB],
  ]);
  await pool.query(`DELETE FROM security.projects WHERE organization_id = ANY($1::uuid[])`, [
    [orgA, orgB],
  ]);
  await pool.end();
});
