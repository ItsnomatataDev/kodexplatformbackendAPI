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
  missingId,
  orgB,
  orgBContext,
  tamperJwt,
  tokenService,
  userA,
  userB,
  userC,
} from './work-harness.js';

async function setupTwoOrgs() {
  const store = new MemoryBoardStore();
  const app = createWorkApp(store, async (userId) => {
    if (userId === userB) {
      return orgBContext();
    }

    return authContext();
  });

  const boardA = await createBoard(app, userA, 'Board A');
  const columnA = await createColumn(app, userA, boardA, 'To Do A');
  const cardA = await createCard(app, userA, boardA, columnA, 'Card A');

  const boardB = await createBoard(app, userB, 'Board B');
  const columnB = await createColumn(app, userB, boardB, 'To Do B');
  const cardB = await createCard(app, userB, boardB, columnB, 'Card B');

  return { app, store, boardA, columnA, cardA, boardB, columnB, cardB };
}

test('unauthenticated, invalid, and tampered credentials are denied across Work routes', async () => {
  const { app, boardA, cardA } = await setupTwoOrgs();
  const routes = [
    `/api/boards`,
    `/api/boards/${boardA}/columns`,
    `/api/boards/${boardA}/cards`,
    `/api/cards/${cardA.id}`,
    `/api/cards/${cardA.id}/comments`,
    `/api/labels`,
  ];

  for (const route of routes) {
    const missing = await json(await app.request(route));
    assert.equal(missing.error?.code, 'MISSING_CREDENTIAL');

    const invalid = await json(
      await app.request(route, {
        headers: { Authorization: 'Bearer not-a-token' },
      }),
    );
    assert.equal(invalid.error?.code, 'INVALID_CREDENTIAL');
  }

  const token = await tokenService.issue(userA);
  const tampered = await json(
    await app.request(`/api/cards/${cardA.id}/comments`, {
      headers: { Authorization: `Bearer ${tamperJwt(token)}` },
    }),
  );
  assert.equal(tampered.error?.code, 'INVALID_CREDENTIAL');
});

test('cross-organization Work resources are not found and lists stay isolated', async () => {
  const { app, boardA, columnA, cardA, boardB, columnB, cardB } = await setupTwoOrgs();
  const authA = await bearer(userA);
  const authB = await bearer(userB);

  const board = await json(
    await app.request(`/api/boards/${boardB}`, { headers: { Authorization: authA } }),
  );
  assert.equal(board.error?.code, 'BOARD_NOT_FOUND');

  const column = await json(
    await app.request(`/api/boards/${boardA}/columns`, {
      method: 'POST',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Stolen', boardId: boardB }),
    }),
  );
  assert.equal(column.error?.code, 'VALIDATION_ERROR');

  const otherBoardColumns = await json(
    await app.request(`/api/boards/${boardB}/columns`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(otherBoardColumns.error?.code, 'BOARD_NOT_FOUND');

  const otherCard = await json(
    await app.request(`/api/cards/${cardB.id}`, { headers: { Authorization: authA } }),
  );
  assert.equal(otherCard.error?.code, 'CARD_NOT_FOUND');

  const commentB = await json(
    await app.request(`/api/cards/${cardB.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: authB,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Org B comment' }),
    }),
  );
  const commentA = await json(
    await app.request(`/api/cards/${cardA.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Org A comment' }),
    }),
  );

  const stolenComment = await json(
    await app.request(`/api/comments/${commentB.comment.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'stolen' }),
    }),
  );
  assert.equal(stolenComment.error?.code, 'COMMENT_NOT_FOUND');

  const mismatchedCommentList = await json(
    await app.request(`/api/cards/${cardA.id}/comments`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(mismatchedCommentList.comments.length, 1);
  assert.equal(mismatchedCommentList.comments[0].id, commentA.comment.id);

  const labelB = await json(
    await app.request('/api/labels', {
      method: 'POST',
      headers: {
        Authorization: authB,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'B', color: '#000' }),
    }),
  );
  const crossLabel = await json(
    await app.request(`/api/cards/${cardA.id}/labels`, {
      method: 'POST',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ labelId: labelB.label.id }),
    }),
  );
  assert.equal(crossLabel.error?.code, 'LABEL_NOT_FOUND');

  const labelsA = await json(
    await app.request('/api/labels', { headers: { Authorization: authA } }),
  );
  assert.equal(
    labelsA.labels.every((label: { organizationId: string }) => label.organizationId !== orgB),
    true,
  );

  const crossWatcher = await json(
    await app.request(`/api/cards/${cardA.id}/watchers`, {
      method: 'POST',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userB }),
    }),
  );
  assert.equal(crossWatcher.error?.code, 'MEMBER_NOT_FOUND');

  const crossAssignee = await json(
    await app.request(`/api/cards/${cardA.id}/assignees`, {
      method: 'POST',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: userB }),
    }),
  );
  assert.equal(crossAssignee.error?.code, 'MEMBER_NOT_FOUND');

  const submissionB = await json(
    await app.request(`/api/cards/${cardB.id}/submissions`, {
      method: 'POST',
      headers: {
        Authorization: authB,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'B submission' }),
    }),
  );
  const stolenSubmission = await json(
    await app.request(`/api/submissions/${submissionB.submission.id}`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(stolenSubmission.error?.code, 'SUBMISSION_NOT_FOUND');
  const mismatchedSubmission = await json(
    await app.request(`/api/cards/${cardA.id}/submissions/${submissionB.submission.id}`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(mismatchedSubmission.error?.code, 'SUBMISSION_NOT_FOUND');

  const attachmentB = await json(
    await app.request(`/api/cards/${cardB.id}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: authB,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'secret.txt',
        contentBase64: Buffer.from('secret').toString('base64'),
      }),
    }),
  );
  const stolenAttachment = await json(
    await app.request(`/api/attachments/${attachmentB.attachment.id}`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(stolenAttachment.error?.code, 'ATTACHMENT_NOT_FOUND');
  const stolenContent = await json(
    await app.request(`/api/attachments/${attachmentB.attachment.id}/content`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(stolenContent.error?.code, 'ATTACHMENT_NOT_FOUND');
  const mismatchedAttachment = await json(
    await app.request(`/api/cards/${cardA.id}/attachments/${attachmentB.attachment.id}`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(mismatchedAttachment.error?.code, 'ATTACHMENT_NOT_FOUND');

  const timeB = await json(
    await app.request(`/api/cards/${cardB.id}/time-entries`, {
      method: 'POST',
      headers: {
        Authorization: authB,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seconds: 60 }),
    }),
  );
  const stolenTime = await json(
    await app.request(`/api/time-entries/${timeB.timeEntry.id}`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(stolenTime.error?.code, 'TIME_ENTRY_NOT_FOUND');

  const historyB = await json(
    await app.request(`/api/cards/${cardB.id}/updates`, {
      headers: { Authorization: authA },
    }),
  );
  assert.equal(historyB.error?.code, 'CARD_NOT_FOUND');

  const boardsA = await json(
    await app.request('/api/boards', { headers: { Authorization: authA } }),
  );
  assert.equal(
    boardsA.boards.every((item: { organizationId: string }) => item.organizationId !== orgB),
    true,
  );

  const cardsA = await json(
    await app.request(`/api/boards/${boardA}/cards`, { headers: { Authorization: authA } }),
  );
  assert.equal(
    cardsA.cards.every((item: { id: string }) => item.id !== cardB.id),
    true,
  );

  void columnA;
  void columnB;
  void userC;
  void missingId;
});

test('relationship mismatches and forged identity fields are rejected', async () => {
  const { app, boardA, cardA, columnB, cardB } = await setupTwoOrgs();
  const authA = await bearer(userA);

  const crossColumn = await json(
    await app.request(`/api/boards/${boardA}/cards`, {
      method: 'POST',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Nope', columnId: columnB }),
    }),
  );
  assert.equal(crossColumn.error?.code, 'COLUMN_NOT_FOUND');

  const moveCrossBoard = await json(
    await app.request(`/api/cards/${cardA.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ columnId: columnB }),
    }),
  );
  assert.equal(moveCrossBoard.error?.code, 'COLUMN_NOT_FOUND');

  const forgedOrg = await json(
    await app.request(`/api/cards/${cardA.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'hi', organizationId: orgB }),
    }),
  );
  assert.equal(forgedOrg.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');

  const commentOnOtherCard = await json(
    await app.request(`/api/cards/${cardB.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: authA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'nope' }),
    }),
  );
  assert.equal(commentOnOtherCard.error?.code, 'CARD_NOT_FOUND');
});
