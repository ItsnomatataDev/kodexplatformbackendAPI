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
  userA,
  userC,
} from './work-harness.js';

const officeInm = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const officeOther = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';

function createPortalApp(tickets = new MemoryTicketStore()) {
  tickets.seedDisplayName(userA, 'Ada Admin');
  tickets.seedOrganization({
    id: orgA,
    name: "IT's No Matata",
    slug: 'its-nomatata',
  });
  tickets.seedOffices(orgA, [
    { id: officeInm, name: "IT's No Matata", slug: 'its-no-matata' },
    { id: officeOther, name: 'Shearwater', slug: 'swtech' },
  ]);
  tickets.seedMember(orgA, userA);
  tickets.seedMember(orgA, userC);
  tickets.seedMemberOffice(orgA, userA, 'its-no-matata');
  tickets.seedMemberOffice(orgA, userC, 'swtech');
  tickets.seedReportRecipient({
    userId: userA,
    fullName: 'Ada Admin',
    email: 'admin@example.com',
    roleKey: 'admin',
  });
  tickets.seedAgent({
    userId: userA,
    fullName: 'Ada Admin',
    email: 'user@example.com',
    officeId: officeInm,
    officeName: "IT's No Matata",
    officeSlug: 'its-no-matata',
  });

  return {
    tickets,
    app: createWorkApp(
      new MemoryBoardStore(),
      async (userId) => {
        if (userId === userC) {
          return orgAMemberContext(userC, {
            membership: {
              isAdminRole: false,
              roleKey: 'media_team',
              officeId: officeOther,
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
        return authContext({
          membership: {
            roleKey: 'it',
            isAdminRole: false,
            officeId: officeInm,
            permissions: {
              tickets: {
                read: true,
                create: true,
                update: true,
                comment: true,
                assign: true,
              },
            },
          },
        });
      },
      undefined,
      { tickets },
    ),
  };
}

test('public portal can create and track an external ticket', async () => {
  const { app } = createPortalApp();

  const org = await json(
    await app.request('/api/tickets/portal/organizations/its-nomatata'),
  );
  assert.equal(org.organization.slug, 'its-nomatata');

  const created = await json(
    await app.request('/api/tickets/portal/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organizationId: orgA,
        fullName: 'External User',
        email: 'external@example.com',
        category: 'Network',
        subject: 'VPN down',
        description: 'Cannot connect from home.',
      }),
    }),
  );
  assert.ok(created.tracking_token);
  assert.equal(created.status, 'open');

  const viewed = await json(
    await app.request(`/api/tickets/portal/tickets/${created.tracking_token}`),
  );
  assert.equal(viewed.ticket.subject, 'VPN down');
  assert.equal(viewed.ticket.external_name, 'External User');

  const comment = await json(
    await app.request(
      `/api/tickets/portal/tickets/${created.tracking_token}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Still broken this morning.' }),
      },
    ),
  );
  assert.ok(comment.id);
});

test('work intelligence is denied for media roles and allowed for INM IT', async () => {
  const { app, tickets } = createPortalApp();
  const staffAuth = await bearer(userA);
  const mediaAuth = await bearer(userC);

  const created = await tickets.create({
    organizationId: orgA,
    userId: userA,
    createdBy: userA,
    category: 'Hardware',
    subject: 'Laptop',
    description: 'Broken hinge',
    assignedTo: userA,
  });

  const denied = await json(
    await app.request('/api/tickets/work-intelligence', {
      method: 'POST',
      headers: {
        Authorization: mediaAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticketIds: [created.id] }),
    }),
  );
  assert.equal(denied.allowed, false);

  const allowed = await json(
    await app.request('/api/tickets/work-intelligence', {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticketIds: [created.id] }),
    }),
  );
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.tickets.length, 1);

  const beat = await json(
    await app.request(`/api/tickets/work-intelligence/${created.id}/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(beat.clock_state, 'running');
  assert.equal(beat.running, true);
});

test('monthly report is blocked for media roles and allowed for IT', async () => {
  const { app } = createPortalApp();
  const staffAuth = await bearer(userA);
  const mediaAuth = await bearer(userC);
  const now = new Date();

  const denied = await app.request('/api/tickets/monthly-report', {
    method: 'POST',
    headers: {
      Authorization: mediaAuth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
    }),
  });
  assert.equal(denied.status, 403);

  const allowed = await json(
    await app.request('/api/tickets/monthly-report', {
      method: 'POST',
      headers: {
        Authorization: staffAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
      }),
    }),
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.totalRecipients, 1);
});
