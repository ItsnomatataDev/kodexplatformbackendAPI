import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db } from '../src/db/pool.js';
import { runAttendanceAutoClockOut } from '../src/attendance/auto-clock-out.js';
import { closeDueAttendanceSessions } from '../src/attendance/reconcile.js';
import { autoClockOutBoundary } from '../src/attendance/harare.js';
import { runTimeEntryAutoStop } from '../src/work/auto-stop.js';
import { PostgresBoardStore } from '../src/work/postgres-store.js';
import { PostgresAttendanceStore } from '../src/attendance/postgres-store.js';

// Real PostgreSQL; explicit opt-in fails when the configured database is unavailable.
test('18:00 attendance and task timer persistence', {
  skip: process.env.RUN_END_OF_DAY_DB_TESTS !== 'true',
}, async (t) => {
  const org = randomUUID(), suspendedOrg = randomUUID();
  const user = randomUUID(), presenceUser = randomUUID(), noProfileUser = randomUUID(), suspendedUser = randomUUID();
  const office = randomUUID(), board = randomUUID(), card = randomUUID();
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `cutoff_failure_${suffix}`;
  const date = '2035-04-09';
  const start = new Date(`${date}T08:00:00+02:00`);
  const cutoff = new Date(`${date}T18:00:00+02:00`);
  const before = new Date(cutoff.getTime() - 1);
  const later = new Date(cutoff.getTime() + 60_000);
  const work = new PostgresBoardStore();
  const attendance = new PostgresAttendanceStore();
  const timers: string[] = [];
  const seedTimer = async (startedAt: Date | null, extra: { endedAt?: Date; seconds?: number; deleted?: boolean } = {}) => {
    const id = randomUUID(); timers.push(id);
    await db.query(`INSERT INTO work.time_entries
      (id,card_id,organization_id,user_id,created_by,seconds,started_at,ended_at,deleted_at)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8)`,
    [id, card, org, user, extra.seconds ?? 0, startedAt, extra.endedAt ?? null, extra.deleted ? start : null]);
    return id;
  };
  const timerRow = async (id: string) => (await db.query('SELECT * FROM work.time_entries WHERE id=$1', [id])).rows[0];
  try {
    await db.query(`INSERT INTO organizations.organizations (id,name,slug,settings)
      VALUES ($1::uuid,'Cutoff',$1::text,'{"attendance":{"auto_clock_out":"20:00"}}'),
             ($2::uuid,'Suspended',$2::text,'{}')`, [org,suspendedOrg]);
    for (const id of [user,presenceUser,noProfileUser,suspendedUser]) {
      await db.query(`INSERT INTO identity.users (id,email,account_status) VALUES ($1,$2,'active')`, [id,`${id}@example.test`]);
      await db.query(`INSERT INTO organizations.memberships (id,organization_id,user_id)
        VALUES ($1,$2,$3)`, [randomUUID(),id === suspendedUser ? suspendedOrg : org,id]);
    }
    await db.query(`UPDATE organizations.organizations SET status='suspended' WHERE id=$1`, [suspendedOrg]);
    await db.query(`INSERT INTO organizations.offices (id,organization_id,name,slug,settings)
      VALUES ($1::uuid,$2,'Presence',$1::text,'{"attendance_mode":"presence_only"}')`, [office,org]);
    await db.query(`INSERT INTO work.boards (id,organization_id,created_by,name,legacy_source,legacy_id)
      VALUES ($1,$2,$3,'Cutoff board','test',$1)`, [board,org,user]);
    await db.query(`INSERT INTO work.cards (id,organization_id,board_id,title,status_key,priority,position,created_at,updated_at,legacy_source,legacy_id)
      VALUES ($1,$2,$3,'Cutoff card','in_progress','normal',0,NOW(),NOW(),'test',$1)`, [card,org,board]);

    await t.test('exact cutoff, startup catch-up, completed/manual/deleted entries, and card totals', async () => {
      const active = await seedTimer(start);
      const manual = await seedTimer(null,{ seconds: 600 });
      const completed = await seedTimer(start,{ endedAt: new Date(start.getTime()+300_000), seconds: 300 });
      const deleted = await seedTimer(start,{ deleted: true });
      assert.equal((await runTimeEntryAutoStop(before,{ organizationId: org })).stopped,0);
      assert.equal((await timerRow(active)).ended_at,null);
      assert.equal((await runTimeEntryAutoStop(later,{ organizationId: org })).stopped,1);
      const closed = await timerRow(active);
      assert.equal(closed.ended_at.toISOString(),cutoff.toISOString());
      assert.equal(closed.auto_stopped_at.toISOString(),cutoff.toISOString());
      assert.equal(closed.seconds,36_000);
      assert.equal((await timerRow(manual)).seconds,600);
      assert.equal((await timerRow(completed)).seconds,300);
      assert.equal((await timerRow(deleted)).ended_at,null);
      assert.equal((await db.query('SELECT tracked_seconds_cache FROM work.cards WHERE id=$1',[card])).rows[0].tracked_seconds_cache,36_900);
      assert.equal((await runTimeEntryAutoStop(later,{ organizationId: org })).stopped,0);
    });

    await t.test('stale browser writes cannot reopen or inflate an automatically stopped segment', async () => {
      const id = timers[0]!;
      await assert.rejects(() => work.updateTimeEntry(org,id,{ endedAt: null }),/stopped automatically/);
      await assert.rejects(() => work.updateTimeEntry(org,id,{ seconds: 72_000 }),/stopped automatically/);
      await assert.rejects(() => work.updateTimeEntry(org,id,{ startedAt: later }),/stopped automatically/);
      assert.equal((await work.updateTimeEntry(org,id,{ note: 'Completed daily work' }))!.seconds,36_000);
      assert.equal((await work.updateTimeEntry(org,id,{ seconds: 36_000, endedAt: cutoff }))!.seconds,36_000);
    });

    await t.test('explicit resume is a new segment and stops at the following daily cutoff', async () => {
      const resumeStart = new Date(`${date}T18:15:00+02:00`);
      const resumed = await work.createTimeEntry({ organizationId: org,cardId: card,userId: user,
        createdBy: user,seconds: 0,startedAt: resumeStart });
      assert.ok(resumed);
      assert.equal(resumed.endedAt,null);
      assert.equal((await runTimeEntryAutoStop(later,{ organizationId: org })).stopped,0);
      assert.equal((await runTimeEntryAutoStop(new Date(`${date}T21:00:00+02:00`),{ organizationId: org })).stopped,0);
      const nextCutoff = autoClockOutBoundary(resumeStart,'18:00');
      assert.equal(nextCutoff.toISOString(),'2035-04-10T16:00:00.000Z');
      await runTimeEntryAutoStop(nextCutoff,{ organizationId: org });
      assert.equal((await timerRow(resumed.id)).ended_at.toISOString(),nextCutoff.toISOString());
      assert.equal((await timerRow(timers[0]!)).seconds,36_000);
    });

    await t.test('database failure rolls back timer and card cache together', async () => {
      const id = await seedTimer(start);
      await db.query(`CREATE FUNCTION work.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN IF NEW.id = '${card}'::uuid THEN RAISE EXCEPTION 'injected card cache failure'; END IF; RETURN NEW; END $f$`);
      await db.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON work.cards FOR EACH ROW EXECUTE FUNCTION work.${trigger}()`);
      try {
        await assert.rejects(() => runTimeEntryAutoStop(later,{ organizationId: org }),/injected card cache failure/);
        assert.equal((await timerRow(id)).ended_at,null);
        assert.equal((await timerRow(id)).auto_stopped_at,null);
      } finally {
        await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON work.cards; DROP FUNCTION IF EXISTS work.${trigger}()`);
      }
      assert.equal((await runTimeEntryAutoStop(later,{ organizationId: org })).stopped,1);
    });

    await t.test('more than one batch and concurrent scheduler calls close each segment once', async () => {
      await db.query(`INSERT INTO work.time_entries
        (id,card_id,organization_id,user_id,created_by,seconds,started_at)
        SELECT gen_random_uuid(),$1,$2,$3,$3,0,$4 FROM generate_series(1,501)`,[card,org,user,start]);
      const results = await Promise.all([runTimeEntryAutoStop(later,{organizationId:org}),runTimeEntryAutoStop(later,{organizationId:org})]);
      assert.equal(results.reduce((sum,r) => sum+r.stopped,0),501);
      const counts = await db.query(`SELECT count(*) FROM work.time_entries
        WHERE organization_id=$1 AND started_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL`,[org]);
      assert.equal(Number(counts.rows[0].count),0);
    });

    await t.test('attendance closes every profile even when notification delivery fails', async () => {
      const sessions = new Map<string,string>();
      for (const id of [user,presenceUser,noProfileUser,suspendedUser]) {
        const sessionId = randomUUID(); sessions.set(id,sessionId);
        await db.query(`INSERT INTO attendance.sessions
          (id,organization_id,user_id,office_id,clock_in_at,notes) VALUES ($1,$2,$3,$4,$5,'Original note')`,
        [sessionId,id===suspendedUser?suspendedOrg:org,id,id===presenceUser?office:null,start]);
      }
      await db.query(`CREATE FUNCTION notifications.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN IF NEW.recipient_user_id = '${user}'::uuid THEN RAISE EXCEPTION 'injected notification failure'; END IF; RETURN NEW; END $f$`);
      await db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON notifications.notifications FOR EACH ROW EXECUTE FUNCTION notifications.${trigger}()`);
      try {
        assert.equal((await runAttendanceAutoClockOut(before)).clockedOut,0);
        const result = await runAttendanceAutoClockOut(later);
        assert.equal(result.clockedOut,4);
        assert.equal(result.failedSessions,0);
      } finally {
        await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON notifications.notifications; DROP FUNCTION IF EXISTS notifications.${trigger}()`);
      }
      for (const [id,sessionId] of sessions) {
        const row = (await db.query('SELECT * FROM attendance.sessions WHERE id=$1',[sessionId])).rows[0];
        assert.equal(row.clock_out_at.toISOString(),cutoff.toISOString());
        assert.equal(row.clock_out_method,'auto');
        assert.equal(row.work_seconds,id===presenceUser?0:36_000);
        assert.ok(row.notes.includes('Original note'));
      }
      assert.equal((await runAttendanceAutoClockOut(later)).clockedOut,0);
    });

    await t.test('one session write failure does not block other profiles and is retried', async () => {
      const bad = randomUUID(), good = randomUUID();
      for (const [id,uid] of [[bad,user],[good,noProfileUser]]) {
        await db.query(`INSERT INTO attendance.sessions (id,organization_id,user_id,clock_in_at)
          VALUES ($1,$2,$3,$4)`,[id,org,uid,start]);
      }
      await db.query(`CREATE FUNCTION attendance.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN IF NEW.id = '${bad}'::uuid THEN RAISE EXCEPTION 'injected session failure'; END IF; RETURN NEW; END $f$`);
      await db.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON attendance.sessions FOR EACH ROW EXECUTE FUNCTION attendance.${trigger}()`);
      try {
        const result = await runAttendanceAutoClockOut(later);
        assert.equal(result.failedSessions,1);
        assert.equal(result.clockedOut,1);
      } finally {
        await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON attendance.sessions; DROP FUNCTION IF EXISTS attendance.${trigger}()`);
      }
      assert.equal((await runAttendanceAutoClockOut(later)).clockedOut,1);
    });

    await t.test('attendance reads catch overdue sessions; explicit later clock-in remains active', async () => {
      const old = await attendance.clockIn({organizationId:org,userId:user,clockInAt:new Date('2020-01-01T06:00:00Z')});
      assert.equal(await attendance.getActiveSession(org,user),null);
      const row = await attendance.getSessionById(org,old.id);
      assert.equal(row!.clockOutAt!.toISOString(),'2020-01-01T16:00:00.000Z');
      const resumed = await attendance.clockIn({organizationId:org,userId:user,clockInAt:new Date(`${date}T18:30:00+02:00`)});
      assert.equal(await closeDueAttendanceSessions(org,user,later),0);
      assert.equal((await attendance.getActiveSession(org,user))!.id,resumed.id);
      assert.equal(await closeDueAttendanceSessions(org,user,new Date('2035-04-10T16:00:00Z')),1);
    });
  } finally {
    for (const schema of ['work','attendance','notifications']) {
      const table = schema === 'work' ? 'cards' : schema === 'attendance' ? 'sessions' : 'notifications';
      await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${schema}.${table}; DROP FUNCTION IF EXISTS ${schema}.${trigger}()`);
    }
    await db.query('DELETE FROM organizations.organizations WHERE id=ANY($1::uuid[])',[[org,suspendedOrg]]);
    await db.query('DELETE FROM identity.users WHERE id=ANY($1::uuid[])',[[user,presenceUser,noProfileUser,suspendedUser]]);
    await db.end();
  }
});
