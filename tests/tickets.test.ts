import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SimpleEmail } from '../src/email/attendance-mailer.js';
import { MemoryNotificationStore } from '../src/notifications/memory-store.js';
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
  extras: {
    notifications?: MemoryNotificationStore;
    sendTicketEmail?: (message: SimpleEmail) => Promise<boolean>;
  } = {},
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
  const notifications = extras.notifications ?? new MemoryNotificationStore();
  notifications.seedDisplayName(userA, 'Ada Admin');
  notifications.seedDisplayName(userC, 'Casey Requester');
  return {
    tickets,
    notifications,
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
      {
        tickets,
        notifications,
        sendTicketEmail: extras.sendTicketEmail,
      },
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
  assert.equal(created.ticket.assignedName, 'Casey Requester');
  assert.ok(Number.isFinite(Date.parse(created.ticket.assignedAt)));
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
  assert.equal(unassigned.ticket.assignedAt, null);
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

test('public technician replies notify the requester; internal notes do not', async () => {
  const emails: SimpleEmail[] = [];
  const notifications = new MemoryNotificationStore();
  const { app } = createTicketApp(undefined, undefined, {
    notifications,
    sendTicketEmail: async (message) => {
      emails.push(message);
      return true;
    },
  });
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
        category: 'hardware',
        subject: 'Printer jam',
        description: 'Third floor printer will not clear.',
      }),
    }),
  );

  const internal = await json(
    await app.request(`/api/tickets/${created.ticket.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: 'Checking toner stock first', visibility: 'internal' }),
    }),
  );
  assert.equal(internal.comment.visibility, 'internal');
  assert.equal(
    (await notifications.list({ organizationId: orgA, recipientUserId: userC })).length,
    0,
  );
  assert.equal(emails.length, 0);

  const publicReply = await json(
    await app.request(`/api/tickets/${created.ticket.id}/comments`, {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: 'Cleared the jam. Please try a test page.',
        visibility: 'public',
      }),
    }),
  );
  assert.equal(publicReply.comment.visibility, 'public');

  const inbox = await notifications.list({
    organizationId: orgA,
    recipientUserId: userC,
  });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.type, 'ticket_comment');
  assert.match(inbox[0]?.message ?? '', /Cleared the jam/);
  assert.equal(emails.length, 1);
  assert.equal(emails[0]?.to, `${userC.slice(0, 8)}@example.com`);
  assert.match(emails[0]?.subject ?? '', /SD-/);

  const requesterView = await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      headers: { Authorization: requesterAuth },
    }),
  );
  assert.equal(requesterView.comments.length, 1);
  assert.equal(requesterView.comments[0]?.body, 'Cleared the jam. Please try a test page.');
});

test('requesters can open attachments on their ticket without nested attachment permissions', async () => {
  const { app } = createTicketApp(undefined, async (userId) => {
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
            },
          },
        },
      });
    }
    return authContext();
  });
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
        category: 'hardware',
        subject: 'Need screenshot',
        description: 'See attached photo of the error.',
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
        filename: 'error.png',
        contentType: 'image/png',
        contentBase64: Buffer.from('fake-png').toString('base64'),
      }),
    }),
  );
  assert.equal(uploaded.attachment.originalFilename, 'error.png');

  const content = await app.request(
    `/api/tickets/${created.ticket.id}/attachments/${uploaded.attachment.id}/content`,
    { headers: { Authorization: requesterAuth } },
  );
  assert.equal(content.status, 200);
  assert.equal(await content.text(), 'fake-png');

  const requesterUpload = await json(
    await app.request(`/api/tickets/${created.ticket.id}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: requesterAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'note.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('more logs').toString('base64'),
      }),
    }),
  );
  assert.equal(requesterUpload.attachment.originalFilename, 'note.txt');
});

test('requesters are emailed when a ticket is assigned, waiting, or resolved', async () => {
  const emails: SimpleEmail[] = [];
  const { app } = createTicketApp(undefined, undefined, {
    sendTicketEmail: async (message) => {
      emails.push(message);
      return true;
    },
  });
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
        category: 'network',
        subject: 'Wi-Fi down',
        description: 'Office wifi dropped at 9am.',
      }),
    }),
  );

  await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assignedTo: userA }),
    }),
  );
  assert.equal(emails.at(-1)?.subject.includes('assigned'), true);

  await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'waiting_for_requester' }),
    }),
  );
  assert.match(emails.at(-1)?.subject ?? '', /Action needed/);

  await json(
    await app.request(`/api/tickets/${created.ticket.id}/close`, {
      method: 'POST',
      headers: {
        Authorization: requesterAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rating: 5, feedback: 'All good now, thanks for the help.' }),
    }),
  );

  await json(
    await app.request(`/api/tickets/${created.ticket.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'resolved',
        actionTaken: 'Reset the access point and confirmed wifi is back.',
      }),
    }),
  );
  assert.match(emails.at(-1)?.subject ?? '', /resolved/);
});

test('requester follow-ups notify and email the assigned technician once per cooldown', async () => {
  const emails: SimpleEmail[] = [];
  const { app, notifications } = createTicketApp(undefined, undefined, {
    sendTicketEmail: async (message) => {
      emails.push(message);
      return true;
    },
  });
  const staffAuth = await bearer(userA);
  const requesterAuth = await bearer(userC);
  const followUp = (ticketId: string, auth: string, message: string) =>
    app.request(`/api/tickets/${ticketId}/follow-up`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

  const created = await json(
    await app.request('/api/tickets', {
      method: 'POST',
      headers: { Authorization: requesterAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'hardware',
        subject: 'Monitor flicker',
        description: 'Second screen flickers all day.',
      }),
    }),
  );
  const ticketId = created.ticket.id as string;

  const unassigned = await followUp(ticketId, requesterAuth, 'Any update?');
  assert.equal(unassigned.status, 409);
  assert.equal((await json(unassigned)).error?.code, 'TICKET_FOLLOW_UP_UNASSIGNED');

  await app.request(`/api/tickets/${ticketId}`, {
    method: 'PATCH',
    headers: { Authorization: staffAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignedTo: userA }),
  });
  emails.length = 0;

  const notRequester = await followUp(ticketId, staffAuth, 'Pinging myself');
  assert.equal(notRequester.status, 404);

  const sent = await followUp(ticketId, requesterAuth, 'Still flickering, can you come by today?');
  assert.equal(sent.status, 201);
  const sentBody = await json(sent);
  assert.equal(sentBody.followUp.emailed, true);
  assert.equal(sentBody.followUp.comment.body, 'Follow-up: Still flickering, can you come by today?');

  const inbox = await notifications.list({ organizationId: orgA, recipientUserId: userA });
  const followUps = inbox.filter((item) => item.type === 'ticket_follow_up');
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0]?.actionUrl, `/it/support/${ticketId}`);
  assert.match(followUps[0]?.message ?? '', /Casey Requester: Still flickering/);

  assert.equal(emails.length, 1);
  assert.equal(emails[0]?.to, `${userA}@example.test`);
  assert.match(emails[0]?.subject ?? '', /Follow-up on ticket SD-/);
  assert.match(emails[0]?.text ?? '', /Still flickering, can you come by today\?/);

  const again = await followUp(ticketId, requesterAuth, 'Hello again');
  assert.equal(again.status, 429);
  assert.equal(emails.length, 1);
});

test('public tracking follow-ups reach the assigned technician', async () => {
  const emails: SimpleEmail[] = [];
  const tickets = new MemoryTicketStore();
  const { app, notifications } = createTicketApp(tickets, undefined, {
    sendTicketEmail: async (message) => {
      emails.push(message);
      return true;
    },
  });
  const publicTicket = await tickets.createPublic({
    organizationId: orgA,
    officeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    externalName: 'Snow Visitor',
    externalCompany: null,
    requesterEmail: 'visitor@example.com',
    externalPhone: null,
    category: 'network',
    subject: 'VPN not connecting',
    description: 'VPN fails from home.',
    priority: 'medium',
  });
  const url = `/api/tickets/portal/tickets/${publicTicket.trackingToken}/follow-up`;
  const post = (message: string) =>
    app.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

  assert.equal((await post('Any news?')).status, 409);

  await tickets.update(orgA, publicTicket.id, { assignedTo: userA }, userA);
  const sent = await post('Still cannot connect this morning.');
  assert.equal(sent.status, 201);
  assert.equal((await json(sent)).follow_up.emailed, true);

  const inbox = await notifications.list({ organizationId: orgA, recipientUserId: userA });
  assert.equal(inbox.filter((item) => item.type === 'ticket_follow_up').length, 1);
  assert.equal(emails.length, 1);
  assert.match(emails[0]?.text ?? '', /Snow Visitor \(visitor@example.com\)/);

  const comments = await tickets.listComments(orgA, publicTicket.id);
  assert.equal(comments.at(-1)?.body, 'Follow-up: Still cannot connect this morning.');
  assert.equal(comments.at(-1)?.authorType, 'external');

  assert.equal((await post('Again')).status, 429);
});
