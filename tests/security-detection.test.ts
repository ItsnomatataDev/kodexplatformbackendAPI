import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { env } from '../src/config/env.js';
import { NotFoundError } from '../src/http/errors.js';
import {
  AUTHENTICATION_FAILURE_BURST_RULE_ID,
  evaluateSecurityEvent,
} from '../src/security/detection-foundation.js';

const orgA = '56565656-5656-4565-8565-565656565656';
const orgB = '78787878-7878-4787-8787-787878787878';
const projectA = '56565656-5656-4565-8565-565656565657';
const projectB = '78787878-7878-4787-8787-787878787879';
const integrationA = '56565656-5656-4565-8565-565656565658';
const integrationB = '56565656-5656-4565-8565-565656565659';
const integrationOther = '78787878-7878-4787-8787-787878787880';

async function insertEvents(
  pool: Pool,
  rows: Array<{
    id: string;
    organizationId: string;
    projectId: string;
    integrationId: string;
    eventType: string;
    createdAt: string;
  }>,
) {
  for (const row of rows) {
    await pool.query(
      `INSERT INTO security.events (
         id, organization_id, project_id, integration_id, event_type, severity, metadata, created_at
       ) VALUES ($1,$2,$3,$4,$5,'low','{"password":"secret","organization_id":"spoof"}',$6)`,
      [row.id, row.organizationId, row.projectId, row.integrationId, row.eventType, row.createdAt],
    );
  }
}

test('security detection foundation', async (t) => {
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
    await pool.query('SELECT 1 FROM security.detection_matches LIMIT 0');
  } catch {
    await pool.end().catch(() => undefined);
    t.skip('security.detection_matches is not available');
    return;
  }

  for (const [id, name] of [
    [orgA, 'detect-a'],
    [orgB, 'detect-b'],
  ] as const) {
    await pool.query(
      `INSERT INTO organizations.organizations (id, name, slug)
       VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`,
      [id, name],
    );
  }
  await pool.query(
    `INSERT INTO security.projects (id, organization_id, slug, name)
     VALUES ($1,$2,'detect-a','Detect A'), ($3,$4,'detect-b','Detect B')
     ON CONFLICT (id) DO NOTHING`,
    [projectA, orgA, projectB, orgB],
  );
  await pool.query(
    `INSERT INTO security.integrations (
       id, organization_id, project_id, slug, name, integration_type
     ) VALUES
       ($1,$2,$3,'detect-a','Detect A','api'),
       ($4,$2,$3,'detect-b','Detect B','api'),
       ($5,$6,$7,'detect-c','Detect C','api')
     ON CONFLICT (id) DO NOTHING`,
    [integrationA, orgA, projectA, integrationB, integrationOther, orgB, projectB],
  );

  const base = Date.parse('2026-03-01T00:00:00.000Z');
  const burst = Array.from({ length: 5 }, (_, index) => ({
    id: `56565656-5656-4565-8565-56565656566${index}`,
    organizationId: orgA,
    projectId: projectA,
    integrationId: integrationA,
    eventType: 'LOGIN_FAILED',
    createdAt: new Date(base + index * 10_000).toISOString(),
  }));
  const otherSubject = {
    id: '56565656-5656-4565-8565-565656565670',
    organizationId: orgA,
    projectId: projectA,
    integrationId: integrationB,
    eventType: 'LOGIN_FAILED',
    createdAt: new Date(base + 20_000).toISOString(),
  };
  const otherType = {
    id: '56565656-5656-4565-8565-565656565671',
    organizationId: orgA,
    projectId: projectA,
    integrationId: integrationA,
    eventType: 'HTTP_REQUEST',
    createdAt: new Date(base + 15_000).toISOString(),
  };
  const foreign = Array.from({ length: 5 }, (_, index) => ({
    id: `78787878-7878-4787-8787-78787878788${index}`,
    organizationId: orgB,
    projectId: projectB,
    integrationId: integrationOther,
    eventType: 'LOGIN_FAILED',
    createdAt: new Date(base + index * 10_000).toISOString(),
  }));
  const stale = Array.from({ length: 5 }, (_, index) => ({
    id: `56565656-5656-4565-8565-56565656568${index}`,
    organizationId: orgA,
    projectId: projectA,
    integrationId: integrationA,
    eventType: 'LOGIN_FAILED',
    createdAt: new Date(base + 3_600_000 + index * 61_000).toISOString(),
  }));
  await insertEvents(pool, [...burst.slice(0, 4), otherSubject, otherType, ...foreign, ...stale]);

  const below = await evaluateSecurityEvent(burst[3]!.id);
  assert.deepEqual(below, { matched: false, ruleId: AUTHENTICATION_FAILURE_BURST_RULE_ID });

  await insertEvents(pool, [burst[4]!]);
  const alertsBefore = await pool.query(
    `SELECT count(*)::int AS n FROM security.alerts WHERE organization_id = $1`,
    [orgA],
  );
  const matched = await evaluateSecurityEvent(burst[4]!.id);
  assert.equal(matched.matched, true);
  if (!matched.matched) return;
  assert.equal(matched.created, true);

  const stored = await pool.query(
    `SELECT organization_id, project_id, integration_id, rule_id, trigger_event_id,
            severity, confidence, evidence
     FROM security.detection_matches WHERE id = $1`,
    [matched.matchId],
  );
  assert.equal(stored.rows[0].organization_id, orgA);
  assert.equal(stored.rows[0].project_id, projectA);
  assert.equal(stored.rows[0].integration_id, integrationA);
  assert.equal(stored.rows[0].rule_id, AUTHENTICATION_FAILURE_BURST_RULE_ID);
  assert.equal(stored.rows[0].trigger_event_id, burst[0]!.id);
  assert.equal(stored.rows[0].severity, 'high');
  assert.equal(Number(stored.rows[0].confidence), 1);
  const evidence = stored.rows[0].evidence as {
    event_count: number;
    event_ids: string[];
    window_seconds: number;
  };
  assert.equal(evidence.event_count, 5);
  assert.equal(evidence.window_seconds, 60);
  assert.deepEqual(evidence.event_ids, burst.map((row) => row.id));
  assert.equal(JSON.stringify(evidence).includes('secret'), false);
  assert.equal(JSON.stringify(evidence).includes('spoof'), false);

  const again = await evaluateSecurityEvent(burst[4]!.id);
  assert.equal(again.matched, true);
  if (again.matched) {
    assert.equal(again.created, false);
    assert.equal(again.matchId, matched.matchId);
  }
  const copies = await pool.query(
    `SELECT count(*)::int AS n FROM security.detection_matches
     WHERE organization_id = $1 AND rule_id = $2 AND trigger_event_id = $3`,
    [orgA, AUTHENTICATION_FAILURE_BURST_RULE_ID, burst[0]!.id],
  );
  assert.equal(copies.rows[0].n, 1);

  const raced = await Promise.all([
    evaluateSecurityEvent(burst[4]!.id),
    evaluateSecurityEvent(burst[4]!.id),
  ]);
  assert.equal(raced.every((result) => result.matched), true);
  const afterRace = await pool.query(
    `SELECT count(*)::int AS n FROM security.detection_matches
     WHERE organization_id = $1 AND rule_id = $2 AND trigger_event_id = $3`,
    [orgA, AUTHENTICATION_FAILURE_BURST_RULE_ID, burst[0]!.id],
  );
  assert.equal(afterRace.rows[0].n, 1);

  const other = await evaluateSecurityEvent(otherSubject.id);
  assert.equal(other.matched, false);
  const typed = await evaluateSecurityEvent(otherType.id);
  assert.equal(typed.matched, false);
  const outside = await evaluateSecurityEvent(stale[4]!.id);
  assert.equal(outside.matched, false);
  const foreignMatch = await evaluateSecurityEvent(foreign[4]!.id);
  assert.equal(foreignMatch.matched, true);
  if (foreignMatch.matched) assert.notEqual(foreignMatch.matchId, matched.matchId);

  const alertsAfter = await pool.query(
    `SELECT count(*)::int AS n FROM security.alerts WHERE organization_id = $1`,
    [orgA],
  );
  assert.equal(alertsAfter.rows[0].n, alertsBefore.rows[0].n);

  await assert.rejects(
    () => evaluateSecurityEvent('56565656-5656-4565-8565-565656565699'),
    (error: unknown) => error instanceof NotFoundError,
  );

  await pool.query(`DELETE FROM security.detection_matches WHERE organization_id IN ($1,$2)`, [
    orgA,
    orgB,
  ]);
  await pool.query(`DELETE FROM security.events WHERE organization_id IN ($1,$2)`, [orgA, orgB]);
  await pool.query(`DELETE FROM security.integrations WHERE organization_id IN ($1,$2)`, [
    orgA,
    orgB,
  ]);
  await pool.query(`DELETE FROM security.projects WHERE organization_id IN ($1,$2)`, [orgA, orgB]);
  await pool.end();
});
