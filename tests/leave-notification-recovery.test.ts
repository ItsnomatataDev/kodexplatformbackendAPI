import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { candidates, CONFIRMATION, ORGANIZATION, parseArguments, assertApplyTarget, recover } from '../scripts/recover-leave-notifications.js';

// A SQL double only: these tests never connect to PostgreSQL, including apply-path tests.
function fixture(options: { badUser?: string; failInsert?: number; mutateBalance?: boolean; nullable?: boolean } = {}) {
  const queries: string[] = [];
  let rows: Record<string, unknown>[] = [];
  let snapshot: typeof rows = [];
  let readOnly = true;
  let inserts = 0;
  let balanceChanged = false;
  const balances = [...new Set(candidates.map((c) => c.userId))].sort().map((user_id) => ({ user_id, leave_days_total: 22, leave_days_remaining: 0 }));
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push(sql);
      const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
      if (sql.startsWith('BEGIN')) { snapshot = structuredClone(rows); readOnly = sql.includes('READ ONLY'); return result(); }
      if (sql === 'ROLLBACK') { rows = structuredClone(snapshot); balanceChanged = false; return result(); }
      if (sql === 'COMMIT') { snapshot = structuredClone(rows); return result(); }
      if (sql.startsWith('LOCK TABLE')) return result();
      if (sql.includes("current_setting('transaction_read_only')")) return result([{ read_only: readOnly ? 'on' : 'off' }]);
      if (sql.includes('information_schema.columns')) return result([
        { column_name: 'leave_type_id', is_nullable: options.nullable === false ? 'NO' : 'YES', data_type: 'uuid', column_default: null },
        { column_name: 'metadata', is_nullable: 'NO', data_type: 'jsonb', column_default: "'{}'::jsonb" },
      ]);
      if (sql.includes('pg_trigger')) return result();
      if (sql.includes('FROM organizations.organizations')) return result([{ id: ORGANIZATION, name: "IT's No matata", slug: 'its-nomatata' }]);
      if (sql.includes('FROM leave.requests ORDER BY id')) return result(structuredClone(rows).sort((a, b) => String(a.id).localeCompare(String(b.id))));
      if (sql.includes('leave_days_total')) return result(balances.map((r) => ({ ...r, leave_days_remaining: balanceChanged ? 1 : 0 })));
      if (sql.includes('FROM identity.users')) {
        const c = candidates.find((c) => c.email === values[0])!;
        return result(c.userId === options.badUser ? [] : [{ id: c.userId, email: c.email }]);
      }
      if (sql.includes('FROM identity.user_profiles')) {
        const c = candidates.find((c) => c.userId === values[0])!;
        return result([{ user_id: c.userId, full_name: c.email, office_id: c.officeId }]);
      }
      if (sql.includes('FROM organizations.memberships')) {
        const c = candidates.find((c) => c.userId === values[0])!;
        return result([{ organization_id: ORGANIZATION, office_id: c.officeId }]);
      }
      if (sql.includes('FROM organizations.offices')) {
        const c = candidates.find((c) => c.officeId === values[0])!;
        return result([{ id: c.officeId, organization_id: ORGANIZATION, name: c.office }]);
      }
      if (sql.startsWith('INSERT INTO leave.requests')) {
        assert.equal(readOnly, false);
        inserts++;
        if (inserts === options.failInsert) throw Error('Simulated insertion failure');
        const [organization_id, user_id, office_id, start_date, end_date, requested_days, office, metadata] = values;
        const row = { id: `new-${inserts}`, organization_id, user_id, office_id, start_date, end_date, requested_days, office, metadata: JSON.parse(String(metadata)), status: 'pending', leave_type_id: null, balance_deducted_at: null, approved_by: null, approved_at: null };
        rows.push(row);
        if (options.mutateBalance) balanceChanged = true;
        return result([row]);
      }
      throw Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as Pick<pg.Client, 'query'>;
  const calculate = ({ startDate }: { startDate: string }) => candidates.find((c) => c.start === startDate)!.days;
  return { client, queries, calculate, rows: () => rows, print: (_value: unknown) => {} };
}

test('default mode is dry-run; apply requires the exact second confirmation', () => {
  assert.deepEqual(parseArguments([]), { apply: false });
  assert.deepEqual(parseArguments(['--dry-run']), { apply: false });
  assert.deepEqual(parseArguments(['--apply', `--confirm=${CONFIRMATION}`]), { apply: true });
  for (const args of [['--apply'], ['--apply', '--dry-run'], ['--apply', '--confirm=yes'], [`--confirm=${CONFIRMATION}`], ['--dry-run', '--dry-run'], ['--unknown']]) assert.throws(() => parseArguments(args));
});

test('apply refuses unreviewed environments and database targets', () => {
  assertApplyTarget({ appEnv: 'development', host: '127.0.0.1', name: 'kode_platform' });
  for (const target of [
    { appEnv: 'production', host: '127.0.0.1', name: 'kode_platform' },
    { appEnv: 'development', host: 'remote', name: 'kode_platform' },
    { appEnv: 'development', host: 'localhost', name: 'kode_production' },
  ]) assert.throws(() => assertApplyTarget(target));
});

test('live VPS target requires explicit selection and exact database identity', () => {
  const live = { appEnv: 'staging', host: '127.0.0.1', name: 'kode_platform_staging' };
  assert.deepEqual(parseArguments(['--dry-run', '--target=live-vps']), { apply: false, target: 'live-vps' });
  assert.deepEqual(parseArguments(['--apply', '--target=live-vps', `--confirm=${CONFIRMATION}`]), { apply: true, target: 'live-vps' });
  assert.throws(() => parseArguments(['--apply', '--target=live-vps']));
  assert.throws(() => assertApplyTarget(live));
  assertApplyTarget(live, 'live-vps');
  for (const target of [
    { ...live, host: 'remote' },
    { ...live, appEnv: 'production' },
    { ...live, name: 'kode_platform' },
  ]) assert.throws(() => assertApplyTarget(target, 'live-vps'));
  assert.throws(() => assertApplyTarget(live, 'unknown'));
});

test('dry-run validates five, excludes Anesu, and performs no mutation statements', async () => {
  const f = fixture();
  const result = await recover(f.client, { ...f, apply: false });
  assert.equal(result.would_create, 5);
  assert.deepEqual(candidates.map((c) => c.candidate), [1, 2, 3, 4, 6]);
  assert.equal(f.rows().length, 0);
  assert(f.queries.every((q) => /^(SELECT|BEGIN.*READ ONLY|ROLLBACK)/.test(q)));
});

test('all candidates validated before insertion; a later identity or duration failure creates nothing', async () => {
  for (const durationFailure of [false, true]) {
    const f = fixture(durationFailure ? {} : { badUser: candidates[2].userId });
    await assert.rejects(recover(f.client, { ...f, apply: true, calculate: durationFailure ? () => 999 : f.calculate }));
    assert.equal(f.queries.filter((q) => q.startsWith('INSERT')).length, 0);
    assert.equal(f.queries.at(-1), 'ROLLBACK');
  }
});

test('non-nullable leave type blocks recovery before insertion', async () => {
  const f = fixture({ nullable: false });
  await assert.rejects(recover(f.client, { ...f, apply: true }));
  assert.equal(f.rows().length, 0);
  assert(!f.queries.some((q) => q.startsWith('INSERT')));
});

test('mock apply is atomic, pending-only, and repeat execution preserves existing records', async () => {
  const f = fixture();
  await recover(f.client, { ...f, apply: true });
  assert.equal(f.rows().length, 5);
  assert(f.rows().every((r) => r.status === 'pending' && r.leave_type_id === null && r.balance_deducted_at === null));
  // A pre-existing different office/status must still be skipped without alteration.
  f.rows()[0]!.office_id = 'different-office';
  f.rows()[0]!.status = 'approved';
  const before = structuredClone(f.rows());
  const rerun = await recover(f.client, { ...f, apply: true });
  assert.equal(rerun.would_create, 0);
  assert.equal(rerun.would_skip, 5);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.queries.filter((q) => q.startsWith('INSERT')).length, 5);
});

test('an insertion failure rolls back earlier mock inserts', async () => {
  const f = fixture({ failInsert: 3 });
  await assert.rejects(recover(f.client, { ...f, apply: true }));
  assert.equal(f.rows().length, 0);
  assert(!f.queries.includes('COMMIT'));
});

test('unexpected balance change blocks commit, without corrective writes', async () => {
  const f = fixture({ mutateBalance: true });
  await assert.rejects(recover(f.client, { ...f, apply: true }), /BALANCE CHANGED/);
  assert(!f.queries.includes('COMMIT'));
  assert.equal(f.rows().length, 0);
  assert(!f.queries.some((q) => /^(UPDATE|DELETE)/.test(q)));
});
