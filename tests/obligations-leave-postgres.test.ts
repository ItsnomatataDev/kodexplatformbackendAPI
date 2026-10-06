import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import { db } from '../src/db/pool.js';
import { PostgresObligationsStore } from '../src/obligations/postgres-store.js';
import { PostgresLeaveStore } from '../src/leave/postgres-store.js';
import { createObligationsRoutes } from '../src/routes/obligations.js';
import { createLeaveRoutes } from '../src/routes/leave.js';
import type { AuthContext } from '../src/authorization/types.js';
import { AppError } from '../src/http/errors.js';

// Explicit opt-in: these tests exercise real PostgreSQL, never a memory store.
test('PostgreSQL handover and leave balance HTTP regression', {
  skip: process.env.RUN_OBLIGATIONS_LEAVE_DB_TESTS !== 'true',
}, async (t) => {
  const org = randomUUID(), otherOrg = randomUUID();
  const owner = randomUUID(), recipient = randomUUID(), outsider = randomUUID(), noProfile = randomUUID();
  const office = randomUUID(), staleOffice = randomUUID();
  const store = new PostgresObligationsStore();
  const leave = new PostgresLeaveStore();
  let actor = owner;
  let admin = false;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      actor: { userId: actor, email: 'test@example.test', isActive: true, accountStatus: 'active', deletedAt: null },
      membership: { membershipId: randomUUID(), organizationId: org, officeId: office, roleId: null,
        roleKey: admin ? 'admin' : 'member', status: 'active', isAdminRole: admin, isManagerRole: false,
        permissions: { leave: { read: true } } },
      organization: { organizationId: org, isActive: true, status: 'active', accessStatus: 'active' },
    } as AuthContext);
    await next();
  });
  app.onError((error, c) => error instanceof AppError
    ? c.json({ code: error.code }, error.status as 400)
    : c.json({ error: error.message }, 500));
  app.route('/obligations', createObligationsRoutes({ store }));
  app.route('/leave', createLeaveRoutes({ store: leave }));
  const post = (url: string, body: unknown) => app.request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await db.query(`INSERT INTO organizations.organizations (id,name,slug) VALUES ($1::uuid,'Regression',$1::text),($2::uuid,'Other',$2::text)`, [org, otherOrg]);
    for (const id of [owner, recipient, outsider, noProfile]) {
      await db.query(`INSERT INTO identity.users (id,email,account_status) VALUES ($1,$2,'active')`, [id, `${id}@example.test`]);
      await db.query(`INSERT INTO organizations.memberships (id,organization_id,user_id) VALUES ($1,$2,$3)`, [randomUUID(), id === outsider ? otherOrg : org, id]);
    }
    for (const id of [office, staleOffice]) {
      await db.query(`INSERT INTO organizations.offices (id,organization_id,name,slug) VALUES ($1::uuid,$2,'Office',$1::text)`, [id, org]);
    }
    await db.query(`UPDATE organizations.memberships SET office_id=$1 WHERE organization_id=$2`, [office, org]);
    await db.query(`INSERT INTO identity.user_profiles (user_id,office_id) VALUES ($1,$2)`, [recipient, staleOffice]);
    const obligation = await store.create({ organizationId: org, title: 'Monthly report', dueDayOfMonth: 10, assigneeId: owner, createdBy: owner });
    const url = `/obligations/${obligation.id}/handover`;
    await t.test('rejects unrelated actors and foreign recipients without changing ownership', async () => {
      actor = recipient;
      assert.equal((await post(url, { assigneeId: owner })).status, 403);
      actor = owner;
      assert.equal((await post(url, { assigneeId: outsider })).status, 400);
      assert.equal((await post(url, { assigneeId: owner })).status, 409);
      assert.equal((await post(url, { assigneeId: 'bad' })).status, 400);
    });
    const before = await store.listWithCurrentOccurrence(org, owner);
    const occurrenceId = before.obligations[0]!.occurrence!.id;
    await t.test('persists handover, moves dashboard, enforces new owner and preserves completion', async () => {
      const response = await post(url, { assigneeId: recipient, note: 'Please take over monthly reporting.' });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).obligation.assignee_id, recipient);
      assert.equal((await store.listWithCurrentOccurrence(org, owner)).obligations.length, 0);
      assert.equal((await store.listWithCurrentOccurrence(org, recipient)).obligations.length, 1);
      assert.equal((await db.query('SELECT * FROM obligations.handovers WHERE obligation_id=$1', [obligation.id])).rowCount, 1);
      assert.equal((await post(`/obligations/occurrences/${occurrenceId}/submit`, {})).status, 404);
      actor = recipient;
      assert.equal((await post(`/obligations/occurrences/${occurrenceId}/submit`, { note: 'Done' })).status, 200);
      assert.equal((await post(`/obligations/occurrences/${occurrenceId}/submit`, {})).status, 409);
      assert.equal((await post(url, { assigneeId: owner })).status, 200);
      const completed = await db.query('SELECT submitted_by, status FROM obligations.occurrences WHERE id=$1', [occurrenceId]);
      assert.equal(completed.rows[0].submitted_by, recipient);
      assert.equal(completed.rows[0].status, 'submitted');
    });
    await t.test('staff PATCH remains compatible, is audited, and leaves omitted fields untouched', async () => {
      actor = recipient;
      admin = true;
      const response = await app.request(`/obligations/${obligation.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Updated monthly report', assigneeId: recipient }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const updated = (await response.json()).obligation;
      assert.equal(updated.title, 'Updated monthly report');
      assert.equal(updated.is_active, true);
      assert.equal(updated.due_day_of_month, 10);
      assert.equal(updated.assignee_id, recipient);
      const history = await app.request(`/obligations/${obligation.id}/handovers`);
      assert.equal(history.status, 200);
      assert.equal((await history.json()).handovers.length, 3);
      admin = false;
      actor = owner;
      assert.equal((await app.request(`/obligations/${obligation.id}/handovers`)).status, 404);
      await assert.rejects(() => store.handover({ organizationId: otherOrg,
        obligationId: String(obligation.id), actorUserId: outsider, assigneeId: outsider, canManage: true }), /Obligation not found/);
    });
    await t.test('concurrent owner handovers commit only one transfer', async () => {
      const concurrent = await store.create({ organizationId: org, title: 'Concurrency', dueDayOfMonth: 5,
        assigneeId: owner, createdBy: owner });
      const results = await Promise.all([
        post(`/obligations/${concurrent.id}/handover`, { assigneeId: recipient }),
        post(`/obligations/${concurrent.id}/handover`, { assigneeId: noProfile }),
      ]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 403]);
      assert.equal((await db.query('SELECT * FROM obligations.handovers WHERE obligation_id=$1', [concurrent.id])).rowCount, 1);
      admin = true;
      await app.request(`/obligations/${concurrent.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isActive: false }) });
      assert.equal((await post(`/obligations/${concurrent.id}/handover`, { assigneeId: owner })).status, 409);
      admin = false;
    });
    await t.test('admin employee list includes missing profiles and accepts all filter; rejects nonstaff', async () => {
      assert.equal((await app.request('/leave/balance/employees')).status, 403);
      admin = true;
      const response = await app.request('/leave/balance/employees?officeId=all');
      assert.equal(response.status, 200, await response.clone().text());
      const { employees } = await response.json();
      assert.equal(employees.length, 3);
      assert.equal(employees.find((e: { id: string }) => e.id === noProfile).leave_days_total, 22);
      assert.equal((await app.request('/leave/balance/employees?officeId=invalid')).status, 400);
      const stale = await app.request(`/leave/balance/employees?officeId=${staleOffice}`);
      assert.equal((await stale.json()).employees.length, 0);
    });
    await t.test('balance updates persist with matching audit and authoritative office filters', async () => {
      for (const userId of [recipient, noProfile]) {
        const response = await app.request(`/leave/balance/${userId}`, { method: 'PATCH',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totalDays: 25, remainingDays: 19, note: 'Annual adjustment' }) });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await leave.getBalance(org, userId)).remainingDays, 19);
      }
      const response = await app.request(`/leave/balance/audit?officeId=${office}`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).entries.length, 2);
      await assert.rejects(() => leave.setBalance({ organizationId: org, userId: outsider, actorUserId: owner, totalDays: 22, remainingDays: 10 }), /Employee not found/);
      await assert.rejects(() => leave.setBalance({ organizationId: org, userId: owner, actorUserId: owner, totalDays: 22, remainingDays: 23 }), /whole non-negative/);
      // A failing audit insert must roll back the balance write.
      await assert.rejects(() => leave.setBalance({ organizationId: org, userId: recipient, actorUserId: randomUUID(), totalDays: 30, remainingDays: 30 }));
      assert.equal((await leave.getBalance(org, recipient)).remainingDays, 19);
    });
  } finally {
    await db.query('DELETE FROM organizations.organizations WHERE id=ANY($1::uuid[])', [[org, otherOrg]]);
    await db.query('DELETE FROM identity.users WHERE id=ANY($1::uuid[])', [[owner, recipient, outsider, noProfile]]);
    await db.end();
  }
});
