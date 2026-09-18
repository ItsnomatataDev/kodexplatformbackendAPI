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
  orgB,
  userA,
  userB,
  userC,
  missingId,
} from './work-harness.js';

test('comments can be created, listed, and updated for a card in the authenticated organization', async () => {
  const app = createWorkApp(new MemoryBoardStore());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);

  const forgedOrg = await json(
    await app.request(`/api/cards/${card.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Hello', organizationId: orgB }),
    }),
  );
  assert.equal(forgedOrg.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');

  const forgedUser = await json(
    await app.request(`/api/cards/${card.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Hello', createdBy: userB }),
    }),
  );
  assert.equal(forgedUser.error?.code, 'USER_OVERRIDE_REJECTED');

  const createdResponse = await app.request(`/api/cards/${card.id}/comments`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: 'Ship it' }),
  });
  const created = await json(createdResponse);
  assert.equal(createdResponse.status, 201);
  assert.equal(created.comment.body, 'Ship it');
  assert.equal(created.comment.organizationId, orgA);
  assert.equal(created.comment.userId, userA);
  assert.equal(created.comment.cardId, card.id);

  const listed = await json(
    await app.request(`/api/cards/${card.id}/comments`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(listed.comments.length, 1);

  const patched = await json(
    await app.request(`/api/comments/${created.comment.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Updated comment' }),
    }),
  );
  assert.equal(patched.comment.body, 'Updated comment');
});

test('labels can be created, assigned, listed, and removed without crossing organizations', async () => {
  const store = new MemoryBoardStore();
  const app = createWorkApp(store);
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);

  const createdLabel = await json(
    await app.request('/api/labels', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Bug', color: '#ff0000' }),
    }),
  );
  assert.equal(createdLabel.label.organizationId, orgA);

  const listed = await json(
    await app.request('/api/labels', { headers: { Authorization: authorization } }),
  );
  assert.equal(listed.labels.length, 1);

  const patched = await json(
    await app.request(`/api/labels/${createdLabel.label.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Defect' }),
    }),
  );
  assert.equal(patched.label.name, 'Defect');

  const assigned = await json(
    await app.request(`/api/cards/${card.id}/labels`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ labelId: createdLabel.label.id }),
    }),
  );
  assert.equal(assigned.label.labelId, createdLabel.label.id);

  const duplicate = await json(
    await app.request(`/api/cards/${card.id}/labels`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ labelId: createdLabel.label.id }),
    }),
  );
  assert.equal(duplicate.error?.code, 'CARD_LABEL_EXISTS');

  const cardLabels = await json(
    await app.request(`/api/cards/${card.id}/labels`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(cardLabels.labels.length, 1);

  const removed = await app.request(
    `/api/cards/${card.id}/labels/${createdLabel.label.id}`,
    {
      method: 'DELETE',
      headers: { Authorization: authorization },
    },
  );
  assert.equal(removed.status, 204);
});

test('watchers and assignees require same-organization members and reject duplicates', async () => {
  const app = createWorkApp(new MemoryBoardStore());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);

  const watcher = await json(
    await app.request(`/api/cards/${card.id}/watchers`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );
  assert.equal(watcher.watcher.userId, userC);

  const duplicateWatcher = await json(
    await app.request(`/api/cards/${card.id}/watchers`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );
  assert.equal(duplicateWatcher.error?.code, 'WATCHER_EXISTS');

  const watchers = await json(
    await app.request(`/api/cards/${card.id}/watchers`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(watchers.watchers.length, 1);

  const crossWatcher = await json(
    await app.request(`/api/cards/${card.id}/watchers`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userB }),
    }),
  );
  assert.equal(crossWatcher.error?.code, 'MEMBER_NOT_FOUND');

  const assignee = await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userC }),
    }),
  );
  assert.equal(assignee.assignee.userId, userC);

  const forgedAssignedBy = await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userA, assignedBy: userB }),
    }),
  );
  assert.equal(forgedAssignedBy.error?.code, 'USER_OVERRIDE_REJECTED');

  const crossAssignee = await json(
    await app.request(`/api/cards/${card.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userB }),
    }),
  );
  assert.equal(crossAssignee.error?.code, 'MEMBER_NOT_FOUND');

  const removeWatcher = await app.request(
    `/api/cards/${card.id}/watchers/${userC}`,
    {
      method: 'DELETE',
      headers: { Authorization: authorization },
    },
  );
  assert.equal(removeWatcher.status, 204);

  const removeAssignee = await app.request(
    `/api/cards/${card.id}/assignees/${userC}`,
    {
      method: 'DELETE',
      headers: { Authorization: authorization },
    },
  );
  assert.equal(removeAssignee.status, 204);
});

test('card history is written for mutations and uses the authenticated actor', async () => {
  const app = createWorkApp(new MemoryBoardStore());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const otherColumn = await createColumn(app, userA, boardId, 'Doing');
  const card = await createCard(app, userA, boardId, columnId, 'Original');

  await app.request(`/api/cards/${card.id}`, {
    method: 'PATCH',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Renamed',
      statusKey: 'doing',
      columnId: otherColumn,
    }),
  });

  const forged = await json(
    await app.request(`/api/cards/${card.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Ignored', actorId: userB }),
    }),
  );
  assert.equal(forged.error?.code, 'USER_OVERRIDE_REJECTED');

  const history = await json(
    await app.request(`/api/cards/${card.id}/updates`, {
      headers: { Authorization: authorization },
    }),
  );
  const types = history.updates.map((update: { updateType: string }) => update.updateType);
  assert.equal(types.includes('created'), true);
  assert.equal(types.includes('title_changed'), true);
  assert.equal(types.includes('status_changed'), true);
  assert.equal(types.includes('column_moved'), true);
  assert.equal(
    history.updates.every((update: { userId: string }) => update.userId === userA),
    true,
  );
});

test('submissions, attachments, and time entries stay on the parent card', async () => {
  const app = createWorkApp(new MemoryBoardStore());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);

  const submission = await json(
    await app.request(`/api/cards/${card.id}/submissions`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Design',
        linkUrl: 'https://example.com/file',
      }),
    }),
  );
  assert.equal(submission.submission.submittedBy, userA);
  assert.equal(submission.submission.approvalStatus, 'pending');

  const reviewed = await json(
    await app.request(`/api/submissions/${submission.submission.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ approvalStatus: 'approved' }),
    }),
  );
  assert.equal(reviewed.submission.approvalStatus, 'approved');
  assert.equal(reviewed.submission.reviewedBy, userA);

  const attachment = await json(
    await app.request(`/api/cards/${card.id}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'notes.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('hello').toString('base64'),
      }),
    }),
  );
  assert.equal(attachment.attachment.originalFilename, 'notes.txt');
  assert.equal(attachment.attachment.objectKey, undefined);

  const content = await app.request(`/api/attachments/${attachment.attachment.id}/content`, {
    headers: { Authorization: authorization },
  });
  assert.equal(content.status, 200);
  assert.equal(await content.text(), 'hello');

  const timeEntry = await json(
    await app.request(`/api/cards/${card.id}/time-entries`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seconds: 900, note: 'Implementation' }),
    }),
  );
  assert.equal(timeEntry.timeEntry.createdBy, userA);
  assert.equal(timeEntry.timeEntry.userId, userA);
  assert.equal(timeEntry.timeEntry.seconds, 900);

  const patchedTime = await json(
    await app.request(`/api/time-entries/${timeEntry.timeEntry.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seconds: 1200 }),
    }),
  );
  assert.equal(patchedTime.timeEntry.seconds, 1200);
});

test('inactive membership and organization cannot use the card ecosystem', async () => {
  const store = new MemoryBoardStore();
  const inactiveMembership = createWorkApp(store, async () =>
    authContext({
      membership: {
        membershipId: 'membership-1',
        organizationId: orgA,
        roleId: 'role-1',
        roleKey: 'admin',
        status: 'suspended',
        isAdminRole: true,
        isManagerRole: false,
        permissions: {},
      },
    }),
  );
  const boardId = await createBoard(createWorkApp(store), userA, 'Board');
  const denied = await json(
    await inactiveMembership.request(`/api/boards/${boardId}/cards`, {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(denied.error?.code, 'MEMBERSHIP_INACTIVE');

  const inactiveOrg = createWorkApp(store, async () =>
    authContext({
      organization: {
        organizationId: orgA,
        isActive: false,
        status: 'suspended',
        accessStatus: 'suspended',
      },
    }),
  );
  const orgDenied = await json(
    await inactiveOrg.request(`/api/labels`, {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(orgDenied.error?.code, 'ORGANIZATION_INACTIVE');
});

test('checklists and items stay on the parent card', async () => {
  const app = createWorkApp(new MemoryBoardStore());
  const authorization = await bearer(userA);
  const boardId = await createBoard(app, userA, 'Board');
  const columnId = await createColumn(app, userA, boardId, 'To Do');
  const card = await createCard(app, userA, boardId, columnId);

  const forged = await json(
    await app.request(`/api/cards/${card.id}/checklists`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Checklist', createdBy: userB }),
    }),
  );
  assert.equal(forged.error?.code, 'USER_OVERRIDE_REJECTED');

  const created = await json(
    await app.request(`/api/cards/${card.id}/checklists`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Launch checklist' }),
    }),
  );
  assert.equal(created.checklist.title, 'Launch checklist');
  assert.equal(created.checklist.createdBy, userA);
  assert.equal(created.checklist.cardId, card.id);
  assert.deepEqual(created.checklist.items, []);

  const item = await json(
    await app.request(`/api/checklists/${created.checklist.id}/items`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Write copy' }),
    }),
  );
  assert.equal(item.item.content, 'Write copy');
  assert.equal(item.item.isCompleted, false);
  assert.equal(item.item.createdBy, userA);
  assert.equal(item.item.checklistId, created.checklist.id);

  const toggled = await json(
    await app.request(`/api/checklist-items/${item.item.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isCompleted: true, completedBy: userB }),
    }),
  );
  assert.equal(toggled.error?.code, 'USER_OVERRIDE_REJECTED');

  const completed = await json(
    await app.request(`/api/checklist-items/${item.item.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isCompleted: true }),
    }),
  );
  assert.equal(completed.item.isCompleted, true);
  assert.equal(completed.item.completedBy, userA);
  assert.equal(typeof completed.item.completedAt, 'string');

  const listed = await json(
    await app.request(`/api/cards/${card.id}/checklists`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(listed.checklists.length, 1);
  assert.equal(listed.checklists[0].items.length, 1);
  assert.equal(listed.checklists[0].items[0].isCompleted, true);

  const deleted = await app.request(`/api/checklist-items/${item.item.id}`, {
    method: 'DELETE',
    headers: { Authorization: authorization },
  });
  assert.equal(deleted.status, 204);

  const afterDelete = await json(
    await app.request(`/api/cards/${card.id}/checklists`, {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(afterDelete.checklists[0].items.length, 0);
});
