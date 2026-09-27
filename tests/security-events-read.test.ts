import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { AccessTokenService } from '../src/auth/access-token.js';
import type { AuthContext } from '../src/authorization/types.js';
import { env } from '../src/config/env.js';

const userA = '11111111-1111-4111-8111-111111111111';
const orgA = '12121212-1212-4121-8121-121212121212';
const orgB = '34343434-3434-4343-8343-343434343434';
const projectA = '12121212-1212-4121-8121-121212121213';
const projectB = '34343434-3434-4343-8343-343434343435';
const integrationA = '12121212-1212-4121-8121-121212121214';
const integrationB = '34343434-3434-4343-8343-343434343436';
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

function appFor(authContext: AuthContext) {
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
        resolveAuthContext: async () => authContext,
        requireActiveSession: async () => undefined,
      },
    }),
  };
}

test('security event list requires authentication', async () => {
  const { app } = appFor(context(orgA, { security: { view: true } }));
  const response = await app.request('/api/security/events');
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error?: { code: string } };
  assert.equal(body.error?.code, 'MISSING_CREDENTIAL');
});

test('security event list rejects a malformed session and a machine credential', async () => {
  const { app } = appFor(context(orgA, { security: { view: true } }));
  const malformed = await app.request('/api/security/events', {
    headers: { authorization: 'Bearer not-a-session' },
  });
  assert.equal(malformed.status, 401);
  const machine = await app.request('/api/security/events', {
    headers: { authorization: 'Bearer kint_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbb' },
  });
  assert.equal(machine.status, 401);
});

test('security event list rejects a member without security.view', async () => {
  const { app, issuer } = appFor(context(orgA, {}));
  const token = await issuer.issue(userA, { sessionId });
  const response = await app.request('/api/security/events', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 403);
});

test('security event read is organization scoped', async (t) => {
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

  await pool.query(
    `INSERT INTO identity.users (id, email, email_normalized, account_status)
     VALUES ($1, $2, $2, 'active') ON CONFLICT (id) DO NOTHING`,
    [userA, 'events-read@example.com'],
  );
  for (const [id, name] of [
    [orgA, 'events-read-a'],
    [orgB, 'events-read-b'],
  ] as const) {
    await pool.query(
      `INSERT INTO organizations.organizations (id, name, slug)
       VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`,
      [id, name],
    );
  }
  await pool.query(
    `INSERT INTO security.projects (id, organization_id, slug, name, environment, status)
     VALUES ($1, $2, 'read-a', 'Read A', 'development', 'active'),
            ($3, $4, 'read-b', 'Read B', 'development', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [projectA, orgA, projectB, orgB],
  );
  await pool.query(
    `INSERT INTO security.integrations (
       id, organization_id, project_id, slug, name, integration_type, status
     ) VALUES
       ($1, $2, $3, 'read-a', 'Read A', 'api', 'active'),
       ($4, $5, $6, 'read-b', 'Read B', 'api', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [integrationA, orgA, projectA, integrationB, orgB, projectB],
  );

  const eventA1 = '12121212-1212-4121-8121-121212121221';
  const eventA2 = '12121212-1212-4121-8121-121212121222';
  const eventA3 = '12121212-1212-4121-8121-121212121223';
  const eventB = '34343434-3434-4343-8343-343434343431';
  await pool.query(
    `INSERT INTO security.events (
       id, organization_id, project_id, integration_id, external_event_id,
       event_type, severity, metadata, created_at
     ) VALUES
       ($1, $2, $3, $4, 'evt_a1', 'HTTP_REQUEST', 'low', '{"message":"a1"}', '2026-01-03T00:00:00Z'),
       ($5, $2, $3, $4, 'evt_a2', 'HTTP_REQUEST', 'high', '{"message":"a2"}', '2026-01-02T00:00:00Z'),
       ($6, $2, NULL, NULL, NULL, 'OTHER_EVENT', 'low', '{}', '2026-01-01T00:00:00Z'),
       ($7, $8, $9, $10, 'evt_b', 'HTTP_REQUEST', 'critical', '{"message":"b"}', '2026-01-04T00:00:00Z')`,
    [eventA1, orgA, projectA, integrationA, eventA2, eventA3, eventB, orgB, projectB, integrationB],
  );

  const view = { security: { view: true } };
  const { app, issuer } = appFor(context(orgA, view));
  const token = await issuer.issue(userA, { sessionId });
  const headers = { authorization: `Bearer ${token}` };

  const listed = await app.request('/api/security/events?limit=50', { headers });
  assert.equal(listed.status, 200);
  const listedBody = (await listed.json()) as {
    events: Array<{ id: string; metadata: Record<string, unknown> }>;
    hasMore: boolean;
  };
  assert.deepEqual(
    listedBody.events.map((event) => event.id),
    [eventA1, eventA2, eventA3],
  );
  assert.equal(JSON.stringify(listedBody).includes('secret_hash'), false);
  assert.equal(JSON.stringify(listedBody).includes(eventB), false);
  assert.equal(JSON.stringify(listedBody).includes('kint_'), false);

  const byProject = await app.request(`/api/security/events?project_id=${projectA}`, { headers });
  assert.equal(byProject.status, 200);
  const projectIds = ((await byProject.json()) as { events: Array<{ id: string }> }).events.map(
    (event) => event.id,
  );
  assert.deepEqual(projectIds, [eventA1, eventA2]);

  const foreignProject = await app.request(`/api/security/events?project_id=${projectB}`, {
    headers,
  });
  assert.equal(foreignProject.status, 200);
  assert.deepEqual(
    ((await foreignProject.json()) as { events: unknown[] }).events,
    [],
  );

  const byIntegration = await app.request(
    `/api/security/events?integration_id=${integrationA}`,
    { headers },
  );
  assert.deepEqual(
    ((await byIntegration.json()) as { events: Array<{ id: string }> }).events.map(
      (event) => event.id,
    ),
    [eventA1, eventA2],
  );
  const foreignIntegration = await app.request(
    `/api/security/events?integration_id=${integrationB}`,
    { headers },
  );
  assert.deepEqual(
    ((await foreignIntegration.json()) as { events: unknown[] }).events,
    [],
  );

  const orgOverride = await app.request(`/api/security/events?organization_id=${orgB}`, { headers });
  assert.equal(orgOverride.status, 400);
  const orgOverrideCamel = await app.request(`/api/security/events?organizationId=${orgB}`, {
    headers,
  });
  assert.equal(orgOverrideCamel.status, 400);

  const typed = await app.request('/api/security/events?event_type=OTHER_EVENT', { headers });
  assert.deepEqual(
    ((await typed.json()) as { events: Array<{ id: string }> }).events.map((event) => event.id),
    [eventA3],
  );
  const severe = await app.request('/api/security/events?severity=high', { headers });
  assert.deepEqual(
    ((await severe.json()) as { events: Array<{ id: string }> }).events.map((event) => event.id),
    [eventA2],
  );
  const ranged = await app.request(
    '/api/security/events?created_from=2026-01-02T00:00:00Z&created_to=2026-01-03T00:00:00Z',
    { headers },
  );
  assert.deepEqual(
    ((await ranged.json()) as { events: Array<{ id: string }> }).events.map((event) => event.id),
    [eventA1, eventA2],
  );

  for (const query of [
    'project_id=not-a-uuid',
    'integration_id=not-a-uuid',
    'severity=catastrophic',
    'event_type=bad%20type',
    'created_from=yesterday',
    'created_from=2026-02-01T00:00:00Z&created_to=2026-01-01T00:00:00Z',
    'limit=-1',
    'limit=201',
    'before=nope&beforeId=12121212-1212-4121-8121-121212121221',
    'before=2026-01-03T00:00:00Z',
    `event_type=${encodeURIComponent("HTTP_REQUEST' OR 1=1 --")}`,
  ]) {
    const rejected = await app.request(`/api/security/events?${query}`, { headers });
    assert.equal(rejected.status, 400, query);
  }

  const page = await app.request('/api/security/events?limit=2', { headers });
  const pageBody = (await page.json()) as {
    events: Array<{ id: string; created_at: string }>;
    hasMore: boolean;
  };
  assert.equal(pageBody.hasMore, true);
  assert.deepEqual(
    pageBody.events.map((event) => event.id),
    [eventA1, eventA2],
  );
  const next = await app.request(
    `/api/security/events?limit=2&before=${encodeURIComponent(pageBody.events[1].created_at)}&beforeId=${pageBody.events[1].id}`,
    { headers },
  );
  const nextBody = (await next.json()) as { events: Array<{ id: string }>; hasMore: boolean };
  assert.deepEqual(
    nextBody.events.map((event) => event.id),
    [eventA3],
  );
  assert.equal(nextBody.hasMore, false);

  const stolen = await app.request(
    `/api/security/events?before=2026-01-04T00:00:00.000Z&beforeId=${eventB}`,
    { headers },
  );
  const stolenIds = ((await stolen.json()) as { events: Array<{ id: string }> }).events.map(
    (event) => event.id,
  );
  assert.equal(stolenIds.includes(eventB), false);
  assert.deepEqual(stolenIds, [eventA1, eventA2, eventA3]);

  const appB = appFor(context(orgB, view));
  const tokenB = await appB.issuer.issue(userA, { sessionId });
  const listedB = await appB.app.request('/api/security/events', {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.deepEqual(
    ((await listedB.json()) as { events: Array<{ id: string }> }).events.map((event) => event.id),
    [eventB],
  );

  await pool.query(`DELETE FROM security.events WHERE organization_id IN ($1, $2)`, [orgA, orgB]);
  await pool.query(`DELETE FROM security.integrations WHERE organization_id IN ($1, $2)`, [
    orgA,
    orgB,
  ]);
  await pool.query(`DELETE FROM security.projects WHERE organization_id IN ($1, $2)`, [orgA, orgB]);
  await pool.end();
});
