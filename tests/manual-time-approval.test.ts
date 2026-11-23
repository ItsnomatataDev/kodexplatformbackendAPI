import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryBoardStore } from '../src/work/memory-store.js';
import {
  authContext,
  bearer,
  createBoard,
  createCard,
  createColumn,
  createWorkApp,
  json,
  orgA,
  orgAMemberContext,
  userA,
  userC,
} from './work-harness.js';

function setup() {
  const store = new MemoryBoardStore();
  const app = createWorkApp(store, async (userId) => {
    if (userId === userC) {
      return orgAMemberContext(userC, {
        membership: {
          isAdminRole: false,
          isManagerRole: false,
          roleKey: 'media_team',
          permissions: {
            work: {
              cards: { read: true, create: true },
              time_entries: { read: true, create: true, update: true, delete: true },
            },
          },
        },
      });
    }
    return authContext();
  });
  return { store, app };
}

async function send(
  app: ReturnType<typeof setup>['app'],
  userId: string,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  const response = await app.request(path, {
    method,
    headers: {
      Authorization: await bearer(userId),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await json(response) };
}

function eightHourEntry(extra: Record<string, unknown> = {}) {
  const endedAt = new Date(Date.now() - 60_000);
  const startedAt = new Date(endedAt.getTime() - 8 * 3600_000);
  return {
    seconds: 8 * 3600,
    note: 'Edited client reel',
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    ...extra,
  };
}

async function prepare() {
  const { store, app } = setup();
  const boardId = await createBoard(app, userA, 'Time board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);
  return { store, app, card };
}

test('manual entries stay open until IT switches them off', async () => {
  const { app, card } = await prepare();
  const policy = await send(app, userC, '/api/time-entries/manual-policy');
  assert.equal(policy.body.settings.manualEntriesEnabled, true);
  assert.equal(policy.body.access.mode, 'direct');
  assert.equal(policy.body.canManageSettings, false);

  const created = await send(app, userC, `/api/cards/${card.id}/time-entries`, 'POST', eightHourEntry());
  assert.equal(created.status, 201);
  assert.equal(created.body.timeEntry.seconds, 8 * 3600);
});

test('only IT and admins can switch manual entries off', async () => {
  const { app } = await prepare();
  const denied = await send(app, userC, '/api/time-entries/manual-settings', 'PUT', {
    manualEntriesEnabled: false,
  });
  assert.equal(denied.status, 403);

  const saved = await send(app, userA, '/api/time-entries/manual-settings', 'PUT', {
    manualEntriesEnabled: false,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.manualEntriesEnabled, false);
});

test('without a vehicle shoot, manual time needs a reason and counts only after approval', async () => {
  const { store, app, card } = await prepare();
  await store.updateManualEntrySettings(orgA, false, userA);

  const blocked = await send(app, userC, `/api/cards/${card.id}/time-entries`, 'POST', eightHourEntry());
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error?.code ?? blocked.body.code, 'MANUAL_ENTRY_APPROVAL_REQUIRED');

  const vague = await send(
    app,
    userC,
    `/api/cards/${card.id}/time-entries`,
    'POST',
    eightHourEntry({ reason: 'forgot' }),
  );
  assert.equal(vague.status, 403);

  const requested = await send(
    app,
    userC,
    `/api/cards/${card.id}/time-entries`,
    'POST',
    eightHourEntry({ reason: 'Laptop died at the client office, worked offline all day.' }),
  );
  assert.equal(requested.status, 202);
  assert.equal(requested.body.pendingApproval, true);
  assert.equal(requested.body.manualTimeRequest.status, 'pending');

  const beforeApproval = await send(app, userC, '/api/time-entries');
  assert.equal(beforeApproval.body.timeEntries.length, 0);

  const mine = await send(app, userC, '/api/time-entries/manual-requests');
  assert.equal(mine.body.manualTimeRequests.length, 1);
  const forbiddenQueue = await send(app, userC, '/api/time-entries/manual-requests?scope=organization');
  assert.equal(forbiddenQueue.status, 403);

  const requestId = requested.body.manualTimeRequest.id as string;
  const selfApprove = await send(app, userC, `/api/time-entries/manual-requests/${requestId}/approve`, 'POST', {});
  assert.equal(selfApprove.status, 403);

  const queue = await send(app, userA, '/api/time-entries/manual-requests?scope=organization&status=pending');
  assert.equal(queue.body.manualTimeRequests.length, 1);

  const approved = await send(app, userA, `/api/time-entries/manual-requests/${requestId}/approve`, 'POST', {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.manualTimeRequest.status, 'approved');
  assert.equal(approved.body.timeEntry.seconds, 8 * 3600);

  const afterApproval = await send(app, userC, '/api/time-entries');
  assert.equal(afterApproval.body.timeEntries.length, 1);

  const again = await send(app, userA, `/api/time-entries/manual-requests/${requestId}/reject`, 'POST', {});
  assert.equal(again.status, 409);
});

test('rejected manual time never becomes a time entry', async () => {
  const { store, app, card } = await prepare();
  await store.updateManualEntrySettings(orgA, false, userA);
  const requested = await send(
    app,
    userC,
    `/api/cards/${card.id}/time-entries`,
    'POST',
    eightHourEntry({ reason: 'Clocked in but forgot to start the timer all day.' }),
  );
  const rejected = await send(
    app,
    userA,
    `/api/time-entries/manual-requests/${requested.body.manualTimeRequest.id}/reject`,
    'POST',
    { reviewNote: 'Track time as you work.' },
  );
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.manualTimeRequest.status, 'rejected');
  assert.equal(rejected.body.timeEntry, null);
  const entries = await send(app, userC, '/api/time-entries');
  assert.equal(entries.body.timeEntries.length, 0);
});

test('a shoot booked with a vehicle that day lets the person log manual time directly', async () => {
  const { store, app, card } = await prepare();
  await store.updateManualEntrySettings(orgA, false, userA);
  const now = new Date();
  store.vehicleShoots.push({
    organizationId: orgA,
    userId: userC,
    id: 'shoot-1',
    title: 'Client launch shoot',
    location: 'Borrowdale',
    status: 'approved',
    startsAt: new Date(now.getTime() - 2 * 3600_000),
    endsAt: new Date(now.getTime() + 3600_000),
    vehicleLabel: 'Hilux ABC123',
  });

  const policy = await send(app, userC, '/api/time-entries/manual-policy');
  assert.equal(policy.body.access.mode, 'direct');
  assert.equal(policy.body.access.shootBooking.vehicleLabel, 'Hilux ABC123');

  const endedAt = new Date(now.getTime() - 60_000);
  const created = await send(app, userC, `/api/cards/${card.id}/time-entries`, 'POST', {
    seconds: 3600,
    startedAt: new Date(endedAt.getTime() - 3600_000).toISOString(),
    endedAt: endedAt.toISOString(),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.timeEntry.seconds, 3600);
});

test('restricted users cannot backdate timers or stretch recorded time', async () => {
  const { store, app, card } = await prepare();
  await store.updateManualEntrySettings(orgA, false, userA);
  const eightAm = new Date(Date.now() - 8 * 3600_000);

  const timer = await send(app, userC, `/api/cards/${card.id}/time-entries`, 'POST', {
    seconds: 0,
    startedAt: eightAm.toISOString(),
  });
  assert.equal(timer.status, 201);
  assert.ok(Date.now() - new Date(timer.body.timeEntry.startedAt).getTime() < 60_000);

  const stretched = await send(app, userC, `/api/time-entries/${timer.body.timeEntry.id}`, 'PATCH', {
    startedAt: eightAm.toISOString(),
  });
  assert.equal(stretched.status, 403);

  const stopped = await send(app, userC, `/api/time-entries/${timer.body.timeEntry.id}`, 'PATCH', {
    endedAt: new Date().toISOString(),
    seconds: 8 * 3600,
  });
  assert.equal(stopped.status, 200);
  assert.ok(stopped.body.timeEntry.seconds < 60);

  const inflated = await send(app, userC, `/api/time-entries/${timer.body.timeEntry.id}`, 'PATCH', {
    seconds: 8 * 3600,
  });
  assert.equal(inflated.status, 403);

  const noteOnly = await send(app, userC, `/api/time-entries/${timer.body.timeEntry.id}`, 'PATCH', {
    note: 'Storyboard',
  });
  assert.equal(noteOnly.status, 200);
});

test('admins and IT are not held back by the switch', async () => {
  const { store, app, card } = await prepare();
  await store.updateManualEntrySettings(orgA, false, userA);
  const created = await send(app, userA, `/api/cards/${card.id}/time-entries`, 'POST', eightHourEntry());
  assert.equal(created.status, 201);
});
