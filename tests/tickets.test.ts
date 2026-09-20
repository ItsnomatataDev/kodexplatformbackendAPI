import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryTicketStore } from '../src/tickets/memory-store.js';
import { MemoryBoardStore } from '../src/work/memory-store.js';
import {
  authContext,
  bearer,
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

function createTicketApp(
  tickets = new MemoryTicketStore(),
  resolve?: Parameters<typeof createWorkApp>[1],
) {
  tickets.seedDisplayName(userA, 'Ada Admin');
  tickets.seedDisplayName(userC, 'Casey Requester');
  tickets.seedAgent({
    userId: userA,
    fullName: 'Ada Admin',
    email: 'user@example.com',
    officeId: null,
    officeName: null,
    officeSlug: null,
  });
  return {
    tickets,
    app: createWorkApp(
      new MemoryBoardStore(),
      resolve ??
        (async (userId) => {
          if (userId === userB) return orgBContext();
          if (userId === userC) {
            return orgAMemberContext(userC, {
              membership: {
                isAdminRole: false,
                roleKey: 'media_team',
                permissions: {
                  tickets: {
                    read: true,
                    create: true,
                    update: true,
                    comment: true,
                    attachments: { read: true, create: true, delete: true },
                  },
                },
              },
            });
          }
          return authContext();
        }),
      undefined,
      { tickets },
    ),
  };
}

test('staff can create, list, assign, and comment on tickets in their organization', async () => {
  const { app } = createTicketApp();
  const actorAuth = await bearer(userA);

  const forged = await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'hardware',
        subject: 'Laptop dead',
        description: 'Will not power on',
        createdBy: userC,
      }),
    }),
  );
  assert.equal(forged.error?.code, 'USER_OVERRIDE_REJECTED');

  const created = await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'hardware',
        subject: 'Laptop dead',
        description: 'Will not power on',
        assignedTo: userC,
      }),
    }),
  );
  assert.equal(created.ticket.organizationId, orgA);
  assert.equal(created.ticket.userId, userA);
  assert.equal(created.ticket.assignedTo, userC);
  assert.equal(created.ticket.status, 'assigned');
  assert.match(created.ticket.ticketNumber, /^SD-/);

  const commented = await json(
    await app.request(`/api/tickets/${created.ticket.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Checking the charger first', visibility: 'internal' }),
    }),
  );
  assert.equal(commented.comment.body, 'Checking the charger first');
  assert.equal(commented.comment.authorId, userA);
  assert.equal(commented.comment.authorName, 'Ada Admin');

  const unassigned = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: actorAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assignedTo: null }),
    }),
  );
  assert.equal(unassigned.ticket.assignedTo, null);
  assert.equal(unassigned.ticket.status, 'open');

  const detail = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      headers: { Authorization: actorAuth },
    }),
  );
  assert.equal(detail.comments.length, 1);

  const listed = await json(
    await app.request('/api/tickets', { headers: { Authorization: actorAuth } }),
  );
  assert.equal(listed.tickets.length, 1);
});

test('requesters only see their own tickets and cannot assign', async () => {
  const { app } = createTicketApp();
  const staffAuth = await bearer(userA);
  const requesterAuth = await bearer(userC);

  await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'access',
        subject: 'Staff ticket',
        description: 'Need VPN for office',
      }),
    }),
  );

  const mine = await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        Authorization: requesterAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'software',
        subject: 'Cannot login',
        description: 'Password reset loop',
      }),
    }),
  );
  assert.equal(mine.ticket.userId, userC);

  const requesterList = await json(
    await app.request('/api/tickets', { headers: { Authorization: requesterAuth } }),
  );
  assert.equal(requesterList.tickets.length, 1);
  assert.equal(requesterList.tickets[0].id, mine.ticket.id);

  const assignDenied = await json(
    await app.request(`/api/tickets/${mine.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: requesterAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assignedTo: userA }),
    }),
  );
  assert.equal(assignDenied.error?.code, 'INSUFFICIENT_PERMISSION');
});

test('tickets stay organization-scoped and {all:true} is not a wildcard', async () => {
  const { app } = createTicketApp();
  const created = await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        Authorization: await bearer(userA),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'network',
        subject: 'Wifi down',
        description: 'Office access point offline',
      }),
    }),
  );

  const otherOrg = await json(
    await app.request('/api/tickets', {
      headers: { Authorization: await bearer(userB) },
    }),
  );
  assert.equal(otherOrg.tickets.length, 0);

  const cross = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      headers: { Authorization: await bearer(userB) },
    }),
  );
  assert.equal(cross.error?.code, 'TICKET_NOT_FOUND');

  const forgedOrg = await json(
    await app.request('/api/tickets', {
      headers: {
        Authorization: await bearer(userA),
        'x-organization-id': orgB,
      },
    }),
  );
  assert.equal(forgedOrg.error?.code, 'ORGANIZATION_OVERRIDE_REJECTED');

  const deniedApp = createTicketApp(
    new MemoryTicketStore(),
    async () =>
      authContext({
        membership: {
          isAdminRole: false,
          roleKey: 'media_team',
          permissions: { all: true },
        },
      }),
  ).app;
  const wildcard = await json(
    await deniedApp.request('/api/tickets', {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(wildcard.error?.code, 'INSUFFICIENT_PERMISSION');
});

test('resolve requires action taken and only the requester can close', async () => {
  const { app } = createTicketApp();
  const staffAuth = await bearer(userA);
  const requesterAuth = await bearer(userC);

  const created = await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        Authorization: requesterAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'software',
        subject: 'Printer jam',
        description: 'Front office printer jammed',
      }),
    }),
  );

  const staffClose = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'closed' }),
    }),
  );
  assert.equal(staffClose.error?.code, 'VALIDATION_ERROR');

  const resolveEarly = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'resolved',
        actionTaken: 'Cleared the jam and replaced the drum unit.',
      }),
    }),
  );
  assert.equal(resolveEarly.error?.code, 'VALIDATION_ERROR');

  const closed = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: requesterAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'closed' }),
    }),
  );
  assert.equal(closed.ticket.status, 'closed');

  const tooShort = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'resolved', actionTaken: 'fixed' }),
    }),
  );
  assert.equal(tooShort.error?.code, 'VALIDATION_ERROR');

  const resolved = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'resolved',
        actionTaken: 'Cleared the jam and replaced the drum unit.',
      }),
    }),
  );
  assert.equal(resolved.ticket.status, 'resolved');
});

test('card-linked ticket lookup stays inside the authenticated organization', async () => {
  const tickets = new MemoryTicketStore();
  const { app } = createTicketApp(tickets);
  const created = await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        Authorization: await bearer(userA),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'hardware',
        subject: 'Monitor flicker',
        description: 'Display flashes on the edit desk',
      }),
    }),
  );
  const cardId = '44444444-4444-4444-4444-444444444444';
  tickets.seedLinkedCard(orgA, cardId, created.ticket.id);

  const found = await json(
    await app.request(`/api/tickets/by-card/${cardId}`, {
      headers: { Authorization: await bearer(userA) },
    }),
  );
  assert.equal(found.ticket.id, created.ticket.id);

  const missing = await json(
    await app.request(`/api/tickets/by-card/${cardId}`, {
      headers: { Authorization: await bearer(userB) },
    }),
  );
  assert.equal(missing.ticket, null);
});

test('ticket attachments stay on the parent ticket and inside the organization', async () => {
  const { app } = createTicketApp();
  const staffAuth = await bearer(userA);
  const otherAuth = await bearer(userB);
  const requesterAuth = await bearer(userC);

  const created = await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'hardware',
        subject: 'Broken scanner',
        description: 'Cannot import receipts',
      }),
    }),
  );

  const uploaded = await json(
    await app.request(`/api/tickets/${created.ticket.id}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'receipt.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('scan log').toString('base64'),
      }),
    }),
  );
  assert.equal(uploaded.attachment.originalFilename, 'receipt.txt');
  assert.equal(uploaded.attachment.objectKey, undefined);
  assert.match(
    uploaded.attachment.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );

  const content = await app.request(
    `/api/tickets/${created.ticket.id}/attachments/${uploaded.attachment.id}/content`,
    { headers: { Authorization: staffAuth } },
  );
  assert.equal(content.status, 200);
  assert.equal(await content.text(), 'scan log');

  const detail = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      headers: { Authorization: staffAuth },
    }),
  );
  assert.equal(detail.attachments.length, 1);

  const rejectedType = await json(
    await app.request(`/api/tickets/${created.ticket.id}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'payload.exe',
        contentType: 'application/octet-stream',
        contentBase64: Buffer.from('binary').toString('base64'),
      }),
    }),
  );
  assert.equal(rejectedType.error?.code, 'VALIDATION_ERROR');

  const otherOrg = await json(
    await app.request(
      `/api/tickets/${created.ticket.id}/attachments/${uploaded.attachment.id}/content`,
      { headers: { Authorization: otherAuth } },
    ),
  );
  assert.equal(otherOrg.error?.code, 'TICKET_NOT_FOUND');

  const requesterDenied = await json(
    await app.request(`/api/tickets/${created.ticket.id}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: requesterAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'note.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('nope').toString('base64'),
      }),
    }),
  );
  assert.equal(requesterDenied.error?.code, 'TICKET_NOT_FOUND');

  const deleted = await app.request(
    `/api/tickets/${created.ticket.id}/attachments/${uploaded.attachment.id}`,
    {
      method: 'DELETE',
      headers: { Authorization: staffAuth },
    },
  );
  assert.equal(deleted.status, 204);
});
