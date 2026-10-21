import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { createChatRoutes } from '../src/routes/chat.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AuthContext } from '../src/authorization/types.js';
import type { ChatStore, ChatMessageRecord, SendMessageInput } from '../src/chat/store.js';
import type { OrganizationDirectoryStore } from '../src/organizations/store.js';
import '../src/types/hono.js';

const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const conversation = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const sender = '11111111-1111-1111-1111-111111111111';
const recipient = '22222222-2222-2222-2222-222222222222';
const outsider = '33333333-3333-3333-3333-333333333333';

function fixture() {
  const files = new MemoryFileStorage();
  const messages: ChatMessageRecord[] = [];
  const store = {
    isMember: async (id: string, user: string) => id === conversation && [sender, recipient].includes(user),
    canReadLegacyAttachment: async () => false,
    getConversation: async () => ({ id: conversation, type: 'group', disappearingSeconds: null }),
    sendMessage: async (input: SendMessageInput) => {
      const row = { ...input, id: '44444444-4444-4444-4444-444444444444', createdAt: new Date(), updatedAt: new Date(), isEdited: false, isDeleted: false } as ChatMessageRecord;
      messages.push(row);
      return row;
    },
    listMessages: async () => messages,
    listReactionsForMessages: async () => [],
  } as unknown as ChatStore;
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user') ?? sender;
    c.set('auth', {
      actor: { userId, email: 'test@example.invalid', isActive: true, accountStatus: 'active', deletedAt: null },
      membership: { membershipId: 'test', organizationId: org, officeId: null, roleId: null, roleKey: 'employee', status: 'active', isAdminRole: false, isManagerRole: false, permissions: { 'chat.read': true, 'chat.write': true } },
      organization: { organizationId: org, isActive: true, status: 'active', accessStatus: 'active' },
    } as AuthContext);
    c.set('limits', { maxAttachmentBytes: 1024, maxRequestBodyBytes: 4096, maxContentStudioUploadBytes: 4096 });
    await next();
  });
  app.route('/api/chat', createChatRoutes({ store, files, directory: {} as OrganizationDirectoryStore }));
  const post = (path: string, body: unknown) => app.request(`/api/chat${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, files, messages, post };
}

for (const contentType of ['image/png', 'application/pdf']) {
  test(`recipient retrieves uploaded ${contentType} bytes and persisted reference`, async () => {
    const { app, messages, post } = fixture();
    const bytes = Buffer.from([0, 255, 128, 25, 42]);
    const upload = await post('/attachments', { conversationId: conversation, fileName: 'shared-file', contentType, contentBase64: bytes.toString('base64') });
    assert.equal(upload.status, 201, await upload.clone().text());
    const { attachment } = await upload.json() as { attachment: { url: string } };
    assert.equal(messages.length, 0, 'upload alone must not claim message delivery');
    const sent = await post(`/conversations/${conversation}/messages`, { attachmentUrl: attachment.url, attachmentName: 'shared-file', messageType: 'file' });
    assert.equal(sent.status, 201, await sent.clone().text());
    const history = await app.request(`/api/chat/conversations/${conversation}/messages`, { headers: { 'x-test-user': recipient } });
    assert.equal(history.status, 200);
    assert.equal((await history.json() as { messages: ChatMessageRecord[] }).messages[0]?.attachmentUrl, attachment.url);
    const received = await app.request(attachment.url, { headers: { 'x-test-user': recipient } });
    assert.equal(received.status, 200);
    assert.equal(received.headers.get('content-type'), contentType);
    assert.deepEqual(Buffer.from(await received.arrayBuffer()), bytes);
    assert.equal((await app.request(attachment.url, { headers: { 'x-test-user': outsider } })).status, 403);
  });
}

test('new uploads require a conversation and unlinked legacy files are private', async () => {
  const { app, post } = fixture();
  assert.equal((await post('/attachments', { fileName: 'x', contentBase64: 'eA==' })).status, 400);
  const objectKey = `${org}/unscoped/file`;
  const result = await app.request(`/api/chat/media?bucket=chat-images&objectKey=${encodeURIComponent(objectKey)}`);
  assert.equal(result.status, 403);
});

test('sender-only previews, missing files and files in other conversations cannot be sent', async () => {
  const { post } = fixture();
  for (const attachmentUrl of [
    'blob:https://example.invalid/local-only',
    'https://[invalid',
    '/api/chat/media/chat-images/%bad',
    `/api/chat/media?bucket=chat-images&objectKey=${org}/${conversation}/missing`,
    `/api/chat/media?bucket=chat-images&objectKey=${org}/${org}/wrong-thread`,
  ]) {
    assert.equal((await post(`/conversations/${conversation}/messages`, { attachmentUrl, messageType: 'image' })).status, 400);
  }
});
