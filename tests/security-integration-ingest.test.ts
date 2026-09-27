import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import { MemoryRateLimiter, type RateLimiter } from '../src/auth/rate-limit.js';
import type { AuthContext } from '../src/authorization/types.js';
import { env } from '../src/config/env.js';
import { issueIntegrationCredential } from '../src/security/integration-credentials.js';

const userA = '11111111-1111-4111-8111-111111111111';
const orgA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const orgB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const secret = 'test-only-access-token-secret-value!!';
const sessionId = '22222222-2222-4222-8222-222222222222';

function context(organizationId: string): AuthContext {
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
      permissions: {
        security: { view: true, manage_assets: true, manage_configuration: true },
      },
    },
    organization: {
      organizationId,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

function appFor(organizationId: string, rateLimiter?: RateLimiter, maxRequestBodyBytes?: number) {
  const issuer = new AccessTokenService({
    secret,
    issuer: 'kode-platform/development',
    audience: 'kode-platform-api/development',
    ttlSeconds: 900,
  });
  return {
    issuer,
    app: createApp({
      rateLimiter,
      limits: maxRequestBodyBytes ? { maxRequestBodyBytes } : undefined,
      auth: {
        verifier: issuer,
        resolveAuthContext: async () => context(organizationId),
        requireActiveSession: async () => undefined,
      },
    }),
  };
}

test('integration ingest rejects a missing credential', async () => {
  const { app } = appFor(orgA);
  const response = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(response.status, 401);
});

test('integration ingest rejects a query-string credential', async () => {
  const { app } = appFor(orgA);
  const response = await app.request('/api/security/ingest?access_token=kint_aaaaaaaaaaaa_bbbb', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(response.status, 401);
});

test('integration ingest rejects a malformed bearer credential', async () => {
  const { app } = appFor(orgA);
  const response = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: 'Bearer not-a-credential',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(response.status, 401);
});

test('integration event ingestion', async (t) => {
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
  const column = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'security' AND table_name = 'events' AND column_name = 'integration_id'`,
  );
  if (!column.rows[0]) {
    await pool.end();
    t.skip('security.events.integration_id is not migrated');
    return;
  }

  const slug = `ing-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO identity.users (id, email, email_normalized, account_status)
     VALUES ($1, $2, $2, 'active') ON CONFLICT (id) DO NOTHING`,
    [userA, `ing-${userA.slice(0, 8)}@example.com`],
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

  const { app, issuer } = appFor(orgA, new MemoryRateLimiter(['development']));
  const token = await issuer.issue(userA, { sessionId });
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  const project = await app.request('/api/security/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Ingest project', slug }),
  });
  assert.equal(project.status, 201);
  const projectId = ((await project.json()) as { project: { id: string } }).project.id;
  const integration = await app.request(
    `/api/security/projects/${projectId}/integrations`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Ingest connector',
        slug: `${slug}-api`,
        integration_type: 'api',
      }),
    },
  );
  assert.equal(integration.status, 201);
  const integrationId = (
    (await integration.json()) as { integration: { id: string } }
  ).integration.id;
  const issued = await issueIntegrationCredential(orgA, userA, projectId, integrationId, 7);
  const credential = issued.credential;

  const unknown = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: 'Bearer kint_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbb',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(unknown.status, 401);

  const denied = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'HTTP_REQUEST',
      organization_id: orgB,
    }),
  });
  assert.equal(denied.status, 400);

  const accepted = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'HTTP_REQUEST',
      severity: 'medium',
      source: 'edge',
      message: 'request observed',
      occurred_at: new Date().toISOString(),
    }),
  });
  assert.equal(accepted.status, 201);
  const acceptedBody = (await accepted.json()) as { accepted: boolean; event_id: string };
  assert.equal(acceptedBody.accepted, true);
  const text = JSON.stringify(acceptedBody);
  assert.equal(text.includes(credential), false);
  assert.equal(text.includes('secret_hash'), false);

  const stored = await pool.query(
    `SELECT organization_id, project_id, integration_id, event_type, severity, metadata
     FROM security.events WHERE id = $1`,
    [acceptedBody.event_id],
  );
  assert.equal(stored.rows[0].organization_id, orgA);
  assert.equal(stored.rows[0].project_id, projectId);
  assert.equal(stored.rows[0].integration_id, integrationId);
  assert.equal(stored.rows[0].event_type, 'HTTP_REQUEST');
  assert.equal(JSON.stringify(stored.rows[0].metadata).includes(credential), false);

  const first = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      external_event_id: 'evt_123',
      event_type: 'HTTP_REQUEST',
      message: 'original',
    }),
  });
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { accepted: boolean; event_id: string };
  const replay = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      external_event_id: 'evt_123',
      event_type: 'HTTP_REQUEST',
      message: 'original',
    }),
  });
  assert.equal(replay.status, 201);
  const replayBody = (await replay.json()) as { accepted: boolean; event_id: string };
  assert.equal(replayBody.accepted, true);
  assert.equal(replayBody.event_id, firstBody.event_id);
  const copies = await pool.query(
    `SELECT count(*)::int AS n FROM security.events
     WHERE integration_id = $1 AND external_event_id = 'evt_123'`,
    [integrationId],
  );
  assert.equal(copies.rows[0].n, 1);

  const changed = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      external_event_id: 'evt_123',
      event_type: 'OTHER_EVENT',
      severity: 'critical',
      message: 'changed',
    }),
  });
  assert.equal(changed.status, 201);
  const changedBody = (await changed.json()) as { event_id: string };
  assert.equal(changedBody.event_id, firstBody.event_id);
  const unchanged = await pool.query(
    `SELECT event_type, severity, metadata->>'message' AS message
     FROM security.events WHERE id = $1`,
    [firstBody.event_id],
  );
  assert.equal(unchanged.rows[0].event_type, 'HTTP_REQUEST');
  assert.equal(unchanged.rows[0].severity, 'low');
  assert.equal(unchanged.rows[0].message, 'original');

  const raced = await Promise.all([
    app.request('/api/security/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        external_event_id: 'evt_race',
        event_type: 'HTTP_REQUEST',
      }),
    }),
    app.request('/api/security/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        external_event_id: 'evt_race',
        event_type: 'HTTP_REQUEST',
      }),
    }),
  ]);
  assert.equal(raced[0].status, 201);
  assert.equal(raced[1].status, 201);
  const raceIds = await Promise.all(
    raced.map(async (response) => ((await response.json()) as { event_id: string }).event_id),
  );
  assert.equal(raceIds[0], raceIds[1]);
  const raceCount = await pool.query(
    `SELECT count(*)::int AS n FROM security.events
     WHERE integration_id = $1 AND external_event_id = 'evt_race'`,
    [integrationId],
  );
  assert.equal(raceCount.rows[0].n, 1);

  const orgBApp = appFor(orgB, new MemoryRateLimiter(['development']));
  const orgBToken = await orgBApp.issuer.issue(userA, { sessionId });
  const orgBHeaders = {
    authorization: `Bearer ${orgBToken}`,
    'content-type': 'application/json',
  };
  const projectB = await orgBApp.app.request('/api/security/projects', {
    method: 'POST',
    headers: orgBHeaders,
    body: JSON.stringify({ name: 'Ingest project B', slug: `${slug}-b` }),
  });
  assert.equal(projectB.status, 201);
  const projectBId = ((await projectB.json()) as { project: { id: string } }).project.id;
  const integrationB = await orgBApp.app.request(
    `/api/security/projects/${projectBId}/integrations`,
    {
      method: 'POST',
      headers: orgBHeaders,
      body: JSON.stringify({
        name: 'Ingest connector B',
        slug: `${slug}-b-api`,
        integration_type: 'api',
      }),
    },
  );
  assert.equal(integrationB.status, 201);
  const integrationBId = (
    (await integrationB.json()) as { integration: { id: string } }
  ).integration.id;
  const issuedB = await issueIntegrationCredential(orgB, userA, projectBId, integrationBId, 7);
  const other = await orgBApp.app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issuedB.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      external_event_id: 'evt_123',
      event_type: 'HTTP_REQUEST',
      organization_id: orgA,
      integration_id: integrationId,
    }),
  });
  assert.equal(other.status, 400);
  const isolated = await orgBApp.app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issuedB.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      external_event_id: 'evt_123',
      event_type: 'HTTP_REQUEST',
    }),
  });
  assert.equal(isolated.status, 201);
  const isolatedBody = (await isolated.json()) as { event_id: string };
  assert.notEqual(isolatedBody.event_id, firstBody.event_id);
  const isolatedRow = await pool.query(
    `SELECT organization_id, project_id, integration_id
     FROM security.events WHERE id = $1`,
    [isolatedBody.event_id],
  );
  assert.equal(isolatedRow.rows[0].organization_id, orgB);
  assert.equal(isolatedRow.rows[0].project_id, projectBId);
  assert.equal(isolatedRow.rows[0].integration_id, integrationBId);

  for (const externalEventId of ['', ' ', 'bad id', 'x'.repeat(129), 'evt/123']) {
    const invalidId = await app.request('/api/security/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        external_event_id: externalEventId,
        event_type: 'HTTP_REQUEST',
      }),
    });
    assert.equal(invalidId.status, 400);
  }

  for (const field of ['project_id', 'integration_id'] as const) {
    const override = await app.request('/api/security/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'HTTP_REQUEST', [field]: orgB }),
    });
    assert.equal(override.status, 400);
  }

  const missingType = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ severity: 'low' }),
  });
  assert.equal(missingType.status, 400);

  const longMessage = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST', message: 'm'.repeat(501) }),
  });
  assert.equal(longMessage.status, 400);

  for (const metadata of [
    { organization_id: orgB },
    { projectId: orgB },
    { integrationId: orgB },
    { detail: { organizationId: orgB, project_id: orgB } },
    { items: [{ integration_id: orgB }] },
  ]) {
    const reserved = await app.request('/api/security/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'HTTP_REQUEST', metadata }),
    });
    assert.equal(reserved.status, 400);
  }

  const badMetadata = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST', metadata: ['not-an-object'] }),
  });
  assert.equal(badMetadata.status, 400);

  const fatMetadata = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'HTTP_REQUEST',
      metadata: { note: 'n'.repeat(9000) },
    }),
  });
  assert.equal(fatMetadata.status, 413);

  const badJson = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: '{',
  });
  assert.equal(badJson.status, 400);

  const oldEvent = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'HTTP_REQUEST',
      occurred_at: '2001-01-01T00:00:00.000Z',
    }),
  });
  assert.equal(oldEvent.status, 400);

  const invalidSeverity = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST', severity: 'catastrophic' }),
  });
  assert.equal(invalidSeverity.status, 400);

  const future = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      event_type: 'HTTP_REQUEST',
      occurred_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  });
  assert.equal(future.status, 400);

  await pool.query(
    `UPDATE security.integration_credentials SET scope = 'other' WHERE id = $1`,
    [issued.credential_id],
  );
  const wrongScope = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(wrongScope.status, 403);
  await pool.query(
    `UPDATE security.integration_credentials SET scope = 'events:write' WHERE id = $1`,
    [issued.credential_id],
  );

  await pool.query(
    `UPDATE security.integration_credentials SET revoked_at = NOW() WHERE id = $1`,
    [issued.credential_id],
  );
  const revoked = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(revoked.status, 401);
  const revokedBody = await revoked.text();
  assert.equal(revokedBody.includes('revoked'), false);
  assert.equal(revokedBody.includes(credential), false);

  await pool.query(
    `UPDATE security.integration_credentials
     SET expires_at = NOW() - INTERVAL '1 minute'
     WHERE id = $1`,
    [issued.credential_id],
  );
  const expired = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(expired.status, 401);
  await pool.query(
    `UPDATE security.integration_credentials
     SET expires_at = NOW() + INTERVAL '1 day', revoked_at = NULL
     WHERE id = $1`,
    [issued.credential_id],
  );
  await pool.query(
    `UPDATE security.integrations SET status = 'paused' WHERE id = $1`,
    [integrationId],
  );
  const paused = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(paused.status, 401);
  assert.equal((await paused.text()).includes('paused'), false);
  await pool.query(
    `UPDATE security.integrations SET status = 'active' WHERE id = $1`,
    [integrationId],
  );
  await pool.query(
    `UPDATE security.integrations SET status = 'revoked' WHERE id = $1`,
    [integrationId],
  );
  const revokedIntegration = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(revokedIntegration.status, 401);
  assert.equal((await revokedIntegration.text()).includes('revoked'), false);
  await pool.query(
    `UPDATE security.integrations SET status = 'active' WHERE id = $1`,
    [integrationId],
  );

  const limited = appFor(orgA, {
    async consume() {
      return { allowed: false, retryAfterSeconds: 1 };
    },
    async inspect() {
      return { allowed: false, retryAfterSeconds: 1 };
    },
  });
  const issued2 = await issueIntegrationCredential(orgA, userA, projectId, integrationId, 7);
  const rate = await limited.app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued2.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST' }),
  });
  assert.equal(rate.status, 429);

  const overIngestCap = await app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued2.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST', message: 'x'.repeat(20_000) }),
  });
  assert.equal(overIngestCap.status, 413);

  const tiny = appFor(orgA, new MemoryRateLimiter(['development']), 64);
  const huge = await tiny.app.request('/api/security/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${issued2.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'HTTP_REQUEST', message: 'x'.repeat(200) }),
  });
  assert.equal(huge.status, 413);

  await pool.query(`DELETE FROM security.events WHERE integration_id = $1`, [integrationId]);
  await pool.query(`DELETE FROM security.events WHERE integration_id = $1`, [integrationBId]);
  await pool.query(`DELETE FROM security.audit_log WHERE organization_id IN ($1, $2)`, [orgA, orgB]);
  await pool.query(
    `DELETE FROM security.integration_credentials WHERE organization_id IN ($1, $2)`,
    [orgA, orgB],
  );
  await pool.query(`DELETE FROM security.integrations WHERE organization_id IN ($1, $2)`, [
    orgA,
    orgB,
  ]);
  await pool.query(`DELETE FROM security.projects WHERE id IN ($1, $2)`, [projectId, projectBId]);
  await pool.end();
});
