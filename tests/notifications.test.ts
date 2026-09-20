import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryNotificationStore } from '../src/notifications/memory-store.js';
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
  orgB,
  orgBContext,
  userA,
  userB,
  userC,
} from './work-harness.js';

function createNotificationApp(
  store = new MemoryBoardStore(),
  notifications = new MemoryNotificationStore(),
  resolve?: Parameters<typeof createWorkApp>[1],
) {
  notifications.seedDisplayName(userA, 'Ada Admin');
  return {
    store,
    notifications,
    app: createWorkApp(
      store,
      resolve ??
        (async (userId) => {
          if (userId === userB) {
            return orgBContext();
          }
          if (userId === userC) {
            return orgAMemberContext(userC);
          }
          return authContext();
        }),
      undefined,
      { notifications },
    ),
  };
}

async function seededCard() {
  const { app, notifications } = createNotificationApp();
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId, 'Ship landing page');
  return { app, notifications, boardId, card };
}

test('assigning a teammate creates a notification for the recipient only', async () => {
  const { app, card } = await seededCard();
  const actorAuth = await bearer(userA);
  const recipientAuth = await bearer(userC);

  const selfAssign = await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userA }),
    }),
  );
  assert.equal(selfAssign.assignee.userId, userA);

  const assigned = await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );
  assert.equal(assigned.assignee.userId, userC);

  const actorInbox = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: actorAuth },
    }),
  );
  assert.equal(actorInbox.notifications.length, 0);
  assert.equal(actorInbox.unreadCount, 0);

  const recipientInbox = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: recipientAuth },
    }),
  );
  assert.equal(recipientInbox.notifications.length, 1);
  assert.equal(recipientInbox.unreadCount, 1);
  assert.equal(recipientInbox.notifications[0].type, 'task_assigned');
  assert.equal(recipientInbox.notifications[0].userId, userC);
  assert.equal(recipientInbox.notifications[0].organizationId, orgA);
  assert.equal(recipientInbox.notifications[0].actorUserId, userA);
  assert.equal(recipientInbox.notifications[0].entityId, card.id);
  assert.match(recipientInbox.notifications[0].message, /Ada Admin/);
  assert.equal(
    recipientInbox.notifications[0].actionUrl,
    `/boards/${card.boardId}?cardId=${card.id}`,
  );
});

test('commenting notifies assignees, creator, and watchers except the author', async () => {
  const { app, card } = await seededCard();
  const actorAuth = await bearer(userA);
  const recipientAuth = await bearer(userC);

  await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );
  await json(
    await app.request(`/api/cards/${card.id}/watchers`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );

  const commented = await json(
    await app.request(`/api/cards/${card.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Needs copy review' }),
    }),
  );
  assert.equal(commented.comment.body, 'Needs copy review');

  const actorInbox = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: actorAuth },
    }),
  );
  assert.equal(actorInbox.notifications.length, 0);

  const recipientInbox = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: recipientAuth },
    }),
  );
  const types = recipientInbox.notifications.map(
    (notification: { type: string }) => notification.type,
  );
  assert.deepEqual(types.sort(), ['task_assigned', 'task_comment']);
  const commentNote = recipientInbox.notifications.find(
    (notification: { type: string }) => notification.type === 'task_comment',
  );
  assert.equal(commentNote.metadata.commentId, commented.comment.id);
  assert.match(commentNote.message, /commented on "Ship landing page"/);
});

test('inbox never trusts a client user or organization override', async () => {
  const { app, card } = await seededCard();
  const actorAuth = await bearer(userA);
  await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );

  const forgedUser = await json(
    await app.request(`/api/notifications?userId=${userC}`, {
      headers: { Authorization: actorAuth },
    }),
  );
  assert.equal(forgedUser.error?.code, 'USER_OVERRIDE_REJECTED');

  const forgedOrg = await json(
    await app.request('/api/notifications', {
      headers: {
        Authorization: actorAuth,
        'x-organization-id': orgB,
      },
    }),
  );
  assert.equal(forgedOrg.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');

  const actorInbox = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: actorAuth },
    }),
  );
  assert.equal(actorInbox.notifications.length, 0);

  const otherOrg = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: await bearer(userB) },
    }),
  );
  assert.equal(otherOrg.notifications.length, 0);
});

test('recipients can mark their own notifications read and cannot mark another inbox', async () => {
  const { app, card } = await seededCard();
  const actorAuth = await bearer(userA);
  const recipientAuth = await bearer(userC);

  await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );

  const inbox = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: recipientAuth },
    }),
  );
  const notificationId = inbox.notifications[0].id as string;

  const stolen = await json(
    await app.request(`/api/notifications/${notificationId}`, {
      method: 'PATCH',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isRead: true }),
    }),
  );
  assert.equal(stolen.error?.code, 'NOTIFICATION_NOT_FOUND');

  const marked = await json(
    await app.request(`/api/notifications/${notificationId}`, {
      method: 'PATCH',
      headers: {
        Authorization: recipientAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isRead: true }),
    }),
  );
  assert.equal(marked.notification.isRead, true);

  const unread = await json(
    await app.request('/api/notifications/unread-count', {
      headers: { Authorization: recipientAuth },
    }),
  );
  assert.equal(unread.unreadCount, 0);

  await json(
    await app.request(`/api/cards/${card.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Second look' }),
    }),
  );

  const markedAll = await json(
    await app.request('/api/notifications/read-all', {
      method: 'POST',
      headers: { Authorization: recipientAuth },
    }),
  );
  assert.equal(markedAll.updated, 1);

  const after = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: recipientAuth },
    }),
  );
  assert.equal(after.unreadCount, 0);
  assert.equal(
    after.notifications.every((notification: { isRead: boolean }) => notification.isRead),
    true,
  );
});

test('nested notification permissions are required and {all:true} is not a wildcard', async () => {
  const store = new MemoryBoardStore();
  const notifications = new MemoryNotificationStore();
  const { app } = createNotificationApp(store, notifications, async (userId) => {
    if (userId === userB) {
      return orgBContext();
    }
    if (userId === userC) {
      return orgAMemberContext(userC, {
        membership: {
          isAdminRole: false,
          roleKey: 'media_team',
          permissions: { all: true },
        },
      });
    }
    return authContext();
  });

  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);
  await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: await bearer(userA),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );

  const denied = await json(
    await app.request('/api/notifications', {
      headers: { Authorization: await bearer(userC) },
    }),
  );
  assert.equal(denied.error?.code, 'INSUFFICIENT_PERMISSION');

  const allowedApp = createNotificationApp(
    store,
    notifications,
    async (userId) => {
      if (userId === userC) {
        return orgAMemberContext(userC, {
          membership: {
            isAdminRole: false,
            roleKey: 'media_team',
            permissions: { notifications: { read: true, update: true } },
          },
        });
      }
      return authContext();
    },
  ).app;

  const allowed = await json(
    await allowedApp.request('/api/notifications', {
      headers: { Authorization: await bearer(userC) },
    }),
  );
  assert.equal(allowed.notifications.length, 1);
});
