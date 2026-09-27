/** Five fixed historical candidates. Default: read-only. Never use the submission API. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const CONFIRMATION = 'RECOVER 5 LEAVE REQUESTS';
export const ORGANIZATION = 'ae975c01-c044-4c5d-b5b5-4b6a06b55957';
const TLB = 'df203192-8a77-4109-8672-f8ea9562155f';
const ITNM = '787930f0-2974-4e98-9ae7-a442d0657add';
export const candidates = [
  { candidate: 1, email: 'kupakwashemanhamo@gmail.com', userId: '0c6f7ed6-40c1-4bc2-b00d-e0ba42710e46', officeId: TLB, office: 'Three Little Birds', start: '2026-12-01', end: '2026-12-15', days: 15 },
  { candidate: 2, email: 'fungaimurambiza@gmail.com', userId: '2789c41a-b8ea-4d5e-b9ea-9dc169ced9aa', officeId: TLB, office: 'Three Little Birds', start: '2026-11-27', end: '2026-12-10', days: 14 },
  { candidate: 3, email: 'arolin@itsnomatata.com', userId: 'd670f370-fdec-48b7-a46b-7a6150af665f', officeId: ITNM, office: "IT's No Matata", start: '2026-11-30', end: '2026-12-11', days: 10 },
  { candidate: 4, email: 'lemuelncube@gmail.com', userId: 'c022ef8d-7ea8-468c-9a75-e9bba6f33935', officeId: TLB, office: 'Three Little Birds', start: '2026-09-13', end: '2026-09-14', days: 2 },
  { candidate: 6, email: 'fungaimurambiza@gmail.com', userId: '2789c41a-b8ea-4d5e-b9ea-9dc169ced9aa', officeId: TLB, office: 'Three Little Birds', start: '2026-09-03', end: '2026-09-06', days: 4 },
] as const;

export const provenance = {
  recovery: {
    type: 'historical_leave_request',
    source: 'SUPPLIED_NOTIFICATION_EVIDENCE',
    historical_status: 'unknown',
    recovered_status: 'pending',
    original_leave_type_label: 'General Leave',
    notification_record_independently_recovered: false,
  },
};

export function parseArguments(args: string[]) {
  const allowed = new Set(['--dry-run', '--apply', '--target=live-vps', `--confirm=${CONFIRMATION}`]);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length) {
    throw new Error('Unknown or repeated argument. Use --dry-run, or --apply with the exact --confirm phrase.');
  }
  const apply = args.includes('--apply');
  if (apply && args.includes('--dry-run')) throw new Error('--apply and --dry-run are mutually exclusive.');
  if (apply !== args.includes(`--confirm=${CONFIRMATION}`)) {
    throw new Error(`Apply requires both --apply and --confirm="${CONFIRMATION}"; confirmation is forbidden in dry-run.`);
  }
  return args.includes('--target=live-vps') ? { apply, target: 'live-vps' as const } : { apply };
}

export function assertApplyTarget(target: { appEnv: string; host: string; name: string }, selected = 'local') {
  const localHost = ['127.0.0.1', 'localhost', '::1'].includes(target.host);
  const allowed = selected === 'live-vps'
    ? target.appEnv === 'staging' && target.name === 'kode_platform_staging'
    : selected === 'local' && target.appEnv === 'development' && target.name === 'kode_platform';
  if (!localHost || !allowed) {
    throw new Error('Apply refused: database does not match the explicitly selected local or live-vps target.');
  }
}

type QueryClient = Pick<pg.Client, 'query'>;
type Calculate = (input: { startDate: string; endDate: string; office: string }) => number;
type RequestRow = {
  id: string; organization_id: string; user_id: string; office_id: string | null;
  start_date: string; end_date: string; requested_days: number; status: string;
  leave_type_id: string | null; metadata: unknown; balance_deducted_at: unknown;
  approved_by: unknown; approved_at: unknown;
};

/** Injected client permits safety tests with a fake database; CLI uses one dedicated connection. */
export async function recover(
  client: QueryClient,
  options: { apply: boolean; calculate: Calculate; print: (value: unknown) => void },
) {
  let committed = false;
  await client.query(options.apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const safety = await client.query("SELECT current_setting('transaction_read_only') AS read_only");
    assert.equal(safety.rows[0]?.read_only, options.apply ? 'off' : 'on', 'Unexpected transaction read-only state.');
    if (options.apply) {
      // Serializes all request writers, including the ordinary API (no unique date key exists).
      // Locks also freeze identity/office/balance inputs until verification and commit.
      await client.query('LOCK TABLE leave.requests IN SHARE ROW EXCLUSIVE MODE');
      await client.query('LOCK TABLE identity.users, identity.user_profiles, organizations.memberships, organizations.organizations, organizations.offices, leave.types IN SHARE MODE');
    }
    const columns = await client.query(`SELECT column_name, is_nullable, data_type, column_default
      FROM information_schema.columns WHERE table_schema = 'leave' AND table_name = 'requests'`);
    assert(columns.rows.some((r) => r.column_name === 'leave_type_id' && r.is_nullable === 'YES' && r.data_type === 'uuid'), 'RECOVERY BLOCKED: nullable UUID leave_type_id required.');
    assert(columns.rows.some((r) => r.column_name === 'metadata' && r.data_type === 'jsonb'), 'RECOVERY BLOCKED: metadata JSONB required.');
    const safeDefaults: Record<string, string> = {
      id: 'gen_random_uuid()', requested_days: '1', status: "'pending'::text",
      metadata: "'{}'::jsonb", created_at: 'now()', updated_at: 'now()',
    };
    for (const row of columns.rows) {
      if (row.column_default != null) assert.equal(row.column_default, safeDefaults[row.column_name], `Unreviewed default: ${row.column_name}`);
    }
    const hooks = await client.query(`SELECT tgname AS name FROM pg_trigger
      WHERE tgrelid = 'leave.requests'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
      UNION ALL SELECT rulename AS name FROM pg_rules WHERE schemaname = 'leave' AND tablename = 'requests'`);
    assert.equal(hooks.rows.length, 0, 'RECOVERY BLOCKED: unreviewed request trigger/rule could mutate other data.');
    const org = await client.query('SELECT id, name, slug FROM organizations.organizations WHERE id = $1', [ORGANIZATION]);
    assert.equal(org.rows.length, 1, 'Organization not found.');
    assert.equal(org.rows[0].name, "IT's No matata", 'Organization name changed.');
    assert.equal(org.rows[0].slug, 'its-nomatata', 'Organization slug changed.');

    const requests = async () => (await client.query('SELECT *, start_date::text AS start_date, end_date::text AS end_date FROM leave.requests ORDER BY id')).rows as RequestRow[];
    const balances = async () => (await client.query('SELECT user_id, leave_days_total, leave_days_remaining FROM identity.user_profiles ORDER BY user_id')).rows;
    const beforeRequests = await requests();
    const beforeBalances = await balances();
    const manifest = [];
    for (const candidate of candidates) {
      const errors: string[] = [];
      const users = await client.query('SELECT id, email FROM identity.users WHERE lower(btrim(email)) = $1', [candidate.email]);
      const profiles = await client.query('SELECT user_id, full_name, office_id FROM identity.user_profiles WHERE user_id = $1', [candidate.userId]);
      const memberships = await client.query("SELECT organization_id, office_id, role_key FROM organizations.memberships WHERE user_id = $1 AND status = 'active'", [candidate.userId]);
      const offices = await client.query('SELECT id, organization_id, name FROM organizations.offices WHERE id = $1', [candidate.officeId]);
      if (users.rows.length !== 1 || users.rows[0]?.id !== candidate.userId || profiles.rows.length !== 1 || memberships.rows.length !== 1 || memberships.rows[0]?.organization_id !== ORGANIZATION) errors.push('BLOCKED — IDENTITY VALIDATION FAILED');
      if (profiles.rows[0]?.office_id !== candidate.officeId || memberships.rows[0]?.office_id !== candidate.officeId || offices.rows.length !== 1 || offices.rows[0]?.organization_id !== ORGANIZATION || offices.rows[0]?.name !== candidate.office) errors.push('BLOCKED — OFFICE VALIDATION FAILED');
      const days = options.calculate({ startDate: candidate.start, endDate: candidate.end, office: candidate.office });
      if (candidate.start > candidate.end || days !== candidate.days) errors.push('BLOCKED — DATE/DURATION VALIDATION FAILED');
      // Deliberately no office or status constraint in duplicate detection.
      const existing = beforeRequests.filter((r) => r.organization_id === ORGANIZATION && r.user_id === candidate.userId && r.start_date === candidate.start && r.end_date === candidate.end);
      if (existing.length > 1) errors.push('BLOCKED — MULTIPLE EXISTING REQUESTS');
      const balance = beforeBalances.find((r) => r.user_id === candidate.userId);
      manifest.push({
        candidate: candidate.candidate, email: candidate.email, user_id: users.rows.length === 1 ? users.rows[0].id : null,
        employee: profiles.rows[0]?.full_name ?? null, organization_id: ORGANIZATION, organization: org.rows[0].name,
        office_id: candidate.officeId, office: candidate.office, start_date: candidate.start, end_date: candidate.end,
        requested_days: days, leave_type_id: null, status: 'pending', existing_request: existing,
        balance_before: balance ?? null, balance_change: 0, metadata: provenance, validation_errors: errors,
        action: errors.length ? 'BLOCKED' : existing.length ? (existing[0]!.office_id !== candidate.officeId ? 'EXISTING REQUEST — OFFICE MISMATCH' : 'SKIP — EXISTING REQUEST') : 'WOULD CREATE',
      });
    }
    options.print({ manifest, excluded: { employee: 'Anesu Chisasa', reason: 'OFFICE_MISMATCH_REVIEW', action: 'DO NOT CREATE' }, requests_before: beforeRequests.length });
    const blocked = manifest.filter((r) => r.validation_errors.length).length;
    const pending = manifest.filter((r) => r.action === 'WOULD CREATE');
    const summary = { candidates: 5, would_create: pending.length, would_skip: manifest.filter((r) => r.existing_request.length && !r.validation_errors.length).length, blocked, excluded_anesu: 1, balance_changes: 0, user_changes: 0, profile_changes: 0, membership_changes: 0, office_changes: 0, leave_type_changes: 0 };
    options.print({ dry_run: summary });
    assert.equal(blocked, 0, 'RECOVERY BLOCKED: validation failed; no candidates applied.');
    if (!options.apply) {
      await client.query('ROLLBACK');
      options.print('RECOVERY DRY-RUN COMPLETE — NO DATABASE MUTATIONS PERFORMED');
      return summary;
    }

    // All candidates have been validated and printed before the first possible INSERT.
    const created: RequestRow[] = [];
    for (const row of pending) {
      const result = await client.query(`INSERT INTO leave.requests
        (organization_id, user_id, office_id, start_date, end_date, requested_days,
         leave_type_id, status, office, metadata, approved_by, approved_at, balance_deducted_at)
        VALUES ($1,$2,$3,$4,$5,$6,NULL,'pending',$7,$8::jsonb,NULL,NULL,NULL)
        RETURNING *, start_date::text AS start_date, end_date::text AS end_date`,
      [row.organization_id, row.user_id, row.office_id, row.start_date, row.end_date, row.requested_days, row.office, JSON.stringify(row.metadata)]);
      assert.equal(result.rows.length, 1, 'Expected exactly one inserted request.');
      created.push(result.rows[0]);
    }
    const verify = async () => {
      const after = await requests();
      assert.deepEqual(await balances(), beforeBalances, 'BALANCE CHANGED UNEXPECTEDLY');
      const newIds = new Set(created.map((r) => r.id));
      assert.deepEqual(after.filter((r) => !newIds.has(r.id)), beforeRequests, 'Existing requests or unrelated rows changed.');
      assert.equal(after.length, beforeRequests.length + created.length);
      for (const candidate of candidates) {
        const matches = after.filter((r) => r.organization_id === ORGANIZATION && r.user_id === candidate.userId && r.start_date === candidate.start && r.end_date === candidate.end);
        assert.equal(matches.length, 1, 'Expected one request per candidate.');
        const row = matches[0]!;
        if (!newIds.has(row.id)) continue; // Existing records are preserved even if their status differs.
        assert.equal(row.office_id, candidate.officeId);
        assert.equal(row.requested_days, candidate.days);
        assert.equal(row.status, 'pending');
        assert.equal(row.leave_type_id, null);
        assert.equal(row.balance_deducted_at, null);
        assert.equal(row.approved_by, null);
        assert.equal(row.approved_at, null);
        assert.deepEqual(row.metadata, provenance);
      }
      return after.length;
    };
    await verify();
    await client.query('COMMIT');
    committed = true;
    options.print({ committed: true, new_recovery_request_ids: created.map((r) => r.id) });
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const count = await verify();
    await client.query('ROLLBACK');
    options.print({ result: 'RECOVERY APPLY COMPLETE', created: created.length, skipped_existing: 5 - created.length, failed: 0, balance_changes: 0, requests_after: count, request_audit_provenance: 'NOT WRITTEN — no established recovery-safe mechanism' });
    return summary;
  } catch (error) {
    // After commit this only closes the read-only verification transaction; never repairs data.
    await client.query('ROLLBACK');
    if (committed) options.print('POST-COMMIT VERIFICATION FAILED — committed recovery requires investigation; no corrective mutation attempted.');
    throw error;
  }
}

async function main() {
  const mode = parseArguments(process.argv.slice(2));
  const { env } = await import('../src/config/env.js');
  const { postgresPoolConfig } = await import('../src/db/pool-config.js');
  const { calculateLeaveDaysForOffice } = await import('../src/leave/postgres-store.js');
  if (mode.apply) assertApplyTarget({ appEnv: env.appEnv, host: env.database.host, name: env.database.name }, mode.target);
  console.log(JSON.stringify({ mode: mode.apply ? 'apply' : 'dry-run', target: { environment: env.appEnv, host: env.database.host, port: env.database.port, database: env.database.name } }, null, 2));
  const client = new pg.Client({ ...postgresPoolConfig(env.database), options: mode.apply ? undefined : '-c default_transaction_read_only=on' });
  try {
    await client.connect();
    await recover(client, { ...mode, calculate: calculateLeaveDaysForOffice, print: (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Avoid logging database error objects, connection strings, or row contents.
    console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : error instanceof Error && !('code' in error) ? error.message : 'Recovery stopped: database operation failed. No automatic correction attempted.');
    process.exitCode = 1;
  });
}
