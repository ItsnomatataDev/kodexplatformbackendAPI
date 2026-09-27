import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryAttendanceStore } from '../src/attendance/memory-store.js';
import { MemoryBoardStore } from '../src/work/memory-store.js';
import {
  authContext,
  bearer,
  createWorkApp,
  json,
  orgA,
  orgAMemberContext,
  orgBContext,
  userA,
  userB,
  userC,
} from './work-harness.js';

function createAttendanceApp(attendance = new MemoryAttendanceStore()) {
  attendance.seedMember(orgA, {
    userId: userA,
    fullName: 'Ada Admin',
    email: 'user@example.com',
    officeId: null,
    officeSlug: null,
    officeSettings: { attendance_mode: 'time_tracked' },
    roleKey: 'admin',
  });
  attendance.seedMember(orgA, {
    userId: userC,
    fullName: 'Casey Member',
    email: 'casey@example.com',
    officeId: null,
    officeSlug: null,
    officeSettings: { attendance_mode: 'time_tracked' },
    roleKey: 'media_team',
  });

  return {
    attendance,
    app: createWorkApp(
      new MemoryBoardStore(),
      async (userId) => {
        if (userId === userB) return orgBContext();
        if (userId === userC) {
          return orgAMemberContext(userC, {
            membership: {
              isAdminRole: false,
              isManagerRole: false,
              roleKey: 'media_team',
              permissions: {
                attendance: { read: true, clock: true },
              },
            },
          });
        }
        return authContext();
      },
      undefined,
      { attendance },
    ),
  };
}

test('member can clock in, load today, and clock out', async () => {
  const { app } = createAttendanceApp();
  const auth = await bearer(userC);

  const forged = await json(
    await app.request('/api/attendance/clock-in', {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: userA,
        notes: 'Morning',
        deviceInfo: { platform: 'test' },
      }),
    }),
  );
  assert.equal(forged.error?.code ?? forged.code, 'VALIDATION_ERROR');

  const clockIn = await json(
    await app.request('/api/attendance/clock-in', {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        notes: 'Morning',
        deviceInfo: { platform: 'test' },
      }),
    }),
  );
  assert.equal(clockIn.session.userId, userC);
  assert.equal(clockIn.session.status, 'active');
  assert.equal(clockIn.session.notes, 'Morning');

  const today = await json(
    await app.request('/api/attendance/today', {
      headers: { Authorization: auth },
    }),
  );
  assert.equal(today.activeSession.id, clockIn.session.id);
  assert.equal(today.sessions.length, 1);

  const duplicate = await app.request('/api/attendance/clock-in', {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(duplicate.status, 409);

  const clockOut = await json(
    await app.request(`/api/attendance/sessions/${clockIn.session.id}/clock-out`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ notes: 'Done' }),
    }),
  );
  assert.equal(clockOut.session.status, 'completed');
  assert.ok(clockOut.session.clockOutAt);
  assert.ok(clockOut.session.workSeconds >= 0);
});

test('staff can admin clock-out another user and read report', async () => {
  const { app } = createAttendanceApp();
  const memberAuth = await bearer(userC);
  const adminAuth = await bearer(userA);

  const clockIn = await json(
    await app.request('/api/attendance/clock-in', {
      method: 'POST',
      headers: {
        Authorization: memberAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }),
  );

  const memberForge = await app.request(
    `/api/attendance/sessions/${clockIn.session.id}/clock-out`,
    {
      method: 'POST',
      headers: {
        Authorization: await bearer(userA),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
  // Admin without method=admin still owns only their own session path;
  // clocking out someone else's session without admin method is forbidden.
  assert.equal(memberForge.status, 403);

  const adminOut = await json(
    await app.request(
      `/api/attendance/sessions/${clockIn.session.id}/clock-out`,
      {
        method: 'POST',
        headers: {
          Authorization: adminAuth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method: 'admin',
          notes: 'Clocked out by admin',
        }),
      },
    ),
  );
  assert.equal(adminOut.session.status, 'completed');
  assert.equal(adminOut.session.clockOutMethod, 'admin');

  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const report = await json(
    await app.request(`/api/attendance/report?from=${from}&to=${to}`, {
      headers: { Authorization: adminAuth },
    }),
  );
  assert.ok(Array.isArray(report.rows));
  const casey = report.rows.find((row: { userId: string }) => row.userId === userC);
  assert.ok(casey);
  assert.equal(casey.status, 'completed');
});

test('members cannot read organization attendance report', async () => {
  const { app } = createAttendanceApp();
  const auth = await bearer(userC);
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const response = await app.request(
    `/api/attendance/report?from=${from}&to=${to}`,
    { headers: { Authorization: auth } },
  );
  assert.equal(response.status, 403);
});
