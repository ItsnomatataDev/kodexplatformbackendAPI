import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { hashClientPin } from '../src/content/pin.js';
import type { ContentClientRecord, ContentStore } from '../src/content/store.js';
import type { SimpleEmail } from '../src/email/attendance-mailer.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { authContext, orgA, sessionAuth, tokenService, userA } from './work-harness.js';

const officeId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const clientId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const scheduleId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const otherScheduleId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function fixture(sendResult = true) {
  const emails: SimpleEmail[] = [];
  let client: ContentClientRecord = {
    id: clientId,
    organizationId: orgA,
    officeId,
    companyName: 'Acme Foods',
    contactName: 'Thandi Moyo',
    email: 'Thandi@Acme.example',
    phone: null,
    internalReviewerEmail: null,
    portalToken: 'portal-token-123',
    loginPinHash: 'old-hash',
    pinLastGeneratedAt: new Date(0),
    pinExpiresAt: null,
    isActive: true,
    aiVoiceProfile: {},
    aiCaptionExamples: [],
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const content = {
    async getClient(organizationId: string, office: string, id: string) {
      return organizationId === orgA && office === officeId && id === clientId ? client : null;
    },
    async getSchedule(organizationId: string, id: string) {
      if (organizationId !== orgA) return null;
      if (id === scheduleId) return { id, organizationId, officeId, clientId, title: 'March schedule' };
      if (id === otherScheduleId) return { id, organizationId, officeId, clientId: null, title: 'Other' };
      return null;
    },
    async updateClient(_org: string, _office: string, _id: string, input: Partial<ContentClientRecord>) {
      client = { ...client, ...input };
      return client;
    },
  } as unknown as ContentStore;
  const app = createApp({
    content,
    files: new MemoryFileStorage(),
    sendContentEmail: async (message) => {
      emails.push(message);
      return sendResult;
    },
    auth: {
      verifier: tokenService,
      resolveAuthContext: async () => authContext({ membership: { officeId } }),
      requireActiveSession: sessionAuth.requireActiveSession,
    },
  });
  return { app, emails, currentClient: () => client };
}

async function send(app: ReturnType<typeof fixture>['app'], body: Record<string, unknown>) {
  const { authorization } = await sessionAuth.issueBearer(userA);
  return app.request(`/api/content-studio/clients/${clientId}/review-email`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ officeId, ...body }),
  });
}

test('client review email carries the portal link, login email, and a fresh working PIN', async () => {
  const { app, emails, currentClient } = fixture();
  const response = await send(app, { scheduleId, authorName: 'Ada' });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.emailed, true);
  assert.equal(result.pin, undefined);
  assert.equal(result.portalUrl, 'https://codex.itsnomatata.com/client-portal/portal-token-123');

  assert.equal(emails.length, 1);
  const email = emails[0]!;
  assert.equal(email.to, 'thandi@acme.example');
  assert.equal(email.actionUrl, result.portalUrl);
  assert.equal(email.actionLabel, 'Open client portal');
  assert.match(email.subject, /March schedule/);
  assert.match(email.text, /Portal link: https:\/\/codex\.itsnomatata\.com\/client-portal\/portal-token-123/);
  assert.match(email.text, /Email: thandi@acme\.example/);
  const pin = /PIN: (\d{6})/.exec(email.text)?.[1];
  assert.ok(pin, 'email should include a 6-digit PIN');
  assert.equal(currentClient().loginPinHash, hashClientPin('portal-token-123', pin));
});

test('client review email returns the PIN to staff when delivery fails', async () => {
  const { app, emails, currentClient } = fixture(false);
  const result = await (await send(app, { scheduleId })).json();
  assert.equal(result.emailed, false);
  assert.match(result.pin, /^\d{6}$/);
  assert.equal(currentClient().loginPinHash, hashClientPin('portal-token-123', result.pin));
  assert.equal(emails.length, 1);
});

test('client review email rejects schedules that belong to another client', async () => {
  const { app, emails } = fixture();
  assert.equal((await send(app, { scheduleId: otherScheduleId })).status, 404);
  assert.equal(emails.length, 0);
});
