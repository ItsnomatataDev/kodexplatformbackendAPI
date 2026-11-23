import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createChatRoutes } from '../src/routes/chat.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AuthContext } from '../src/authorization/types.js';
import type {
  ChatMessageRecord,
  ChatStore,
  SendMessageInput,
  SendMessageResult,
} from '../src/chat/store.js';
import {
  assertClientMessageRetryAllowed,
  clientMessagePayloadsMatch,
  normalizeClientMessagePayload,
} from '../src/chat/client-message-idempotency.js';
import { ConflictError } from '../src/http/errors.js';
import type { OrganizationDirectoryStore } from '../src/organizations/store.js';
import '../src/types/hono.js';

const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const conversation = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const otherConversation = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const sender = '11111111-1111-1111-1111-111111111111';
const outsider = '33333333-3333-3333-3333-333333333333';

test('normalize + match treats trimmed equivalent payloads as identical', () => {
  const a = normalizeClientMessagePayload({
    body: ' hello ',
    messageType: 'text',
    attachmentUrl: null,
  });
  const b = normalizeClientMessagePayload({
    body: 'hello',
    messageType: 'text',
  });
  assert.equal(clientMessagePayloadsMatch(a, b), true);
});

test('conflicting payload reuse throws CHAT_CLIENT_MESSAGE_CONFLICT', () => {
  const existing = normalizeClientMessagePayload({ body: 'one', messageType: 'text' });
  const incoming = normalizeClientMessagePayload({ body: 'two', messageType: 'text' });
  assert.throws(
    () => assertClientMessageRetryAllowed(existing, incoming),
    (error: unknown) =>
      error instanceof ConflictError && error.code === 'CHAT_CLIENT_MESSAGE_CONFLICT',
  );
});

function idempotentMemoryStore() {
  const messages: ChatMessageRecord[] = [];
  const locks = new Map<string, Promise<void>>();

  async function withKeyLock(key: string, fn: () => Promise<SendMessageResult>) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(
      key,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  const store = {
    isMember: async (id: string, user: string) =>
      (id === conversation || id === otherConversation) && user === sender,
    canReadLegacyAttachment: async () => false,
    getConversation: async (organizationId: string, id: string) =>
      organizationId === org && (id === conversation || id === otherConversation)
        ? {
            id,
            organizationId: org,
            officeId: null,
            title: null,
            type: 'direct' as const,
            createdBy: sender,
            lastMessageAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            disappearingSeconds: null,
          }
        : null,
    listMembers: async () => [
      {
        id: 'm1',
        conversationId: conversation,
        userId: sender,
        role: 'member' as const,
        joinedAt: new Date(),
        isMuted: false,
        lastReadMessageId: null,
        lastReadAt: null,
      },
    ],
    isEitherBlocked: async () => false,
    sendMessage: async (input: SendMessageInput): Promise<SendMessageResult> => {
      const clientMessageId = input.clientMessageId?.trim() || null;
      const payload = normalizeClientMessagePayload(input);

      const insert = async (): Promise<SendMessageResult> => {
        if (clientMessageId) {
          const existing = messages.find(
            (row) =>
              row.conversationId === input.conversationId &&
              row.senderId === input.senderId &&
              row.clientMessageId === clientMessageId,
          );
          if (existing) {
            assertClientMessageRetryAllowed(
              normalizeClientMessagePayload(existing),
              payload,
            );
            return { message: existing, created: false };
          }
        }

        const row: ChatMessageRecord = {
          id: randomUUID(),
          conversationId: input.conversationId,
          organizationId: input.organizationId,
          senderId: input.senderId,
          body: payload.body,
          messageType: payload.messageType,
          replyToMessageId: payload.replyToMessageId,
          attachmentUrl: payload.attachmentUrl,
          attachmentName: payload.attachmentName,
          metadata: input.metadata ?? {},
          isEdited: false,
          isDeleted: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          clientMessageId,
          expiresAt: input.expiresAt ?? null,
        };
        messages.push(row);
        return { message: row, created: true };
      };

      if (!clientMessageId) return insert();
      const key = `${input.conversationId}:${input.senderId}:${clientMessageId}`;
      return withKeyLock(key, insert);
    },
    listMessages: async () => messages,
    listReactionsForMessages: async () => [],
    getMessage: async (_org: string, messageId: string) =>
      messages.find((row) => row.id === messageId) ?? null,
  } as unknown as ChatStore;

  return { store, messages };
}

function fixture() {
  const { store, messages } = idempotentMemoryStore();
  const files = new MemoryFileStorage();
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user') ?? sender;
    c.set('auth', {
      actor: {
        userId,
        email: 'test@example.invalid',
        isActive: true,
        accountStatus: 'active',
        deletedAt: null,
      },
      membership: {
        membershipId: 'test',
        organizationId: org,
        officeId: null,
        roleId: null,
        roleKey: 'employee',
        status: 'active',
        isAdminRole: false,
        isManagerRole: false,
        permissions: { 'chat.read': true, 'chat.write': true },
      },
      organization: {
        organizationId: org,
        isActive: true,
        status: 'active',
        accessStatus: 'active',
      },
    } as AuthContext);
    c.set('limits', {
      maxAttachmentBytes: 1024,
      maxRequestBodyBytes: 4096,
      maxContentStudioUploadBytes: 4096,
    });
    await next();
  });
  app.route(
    '/api/chat',
    createChatRoutes({
      store,
      files,
      directory: {} as OrganizationDirectoryStore,
    }),
  );

  const post = (path: string, body: unknown, user = sender) =>
    app.request(`/api/chat${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': user,
      },
      body: JSON.stringify(body),
    });

  return { messages, post };
}

test('one send creates one database message', async () => {
  const { messages, post } = fixture();
  const clientMessageId = randomUUID();
  const res = await post(`/conversations/${conversation}/messages`, {
    body: 'hello',
    messageType: 'text',
    clientMessageId,
  });
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.clientMessageId, clientMessageId);
  const json = (await res.json()) as { created: boolean; message: { id: string } };
  assert.equal(json.created, true);
});

test('duplicate submission returns the existing message without a second row', async () => {
  const { messages, post } = fixture();
  const clientMessageId = randomUUID();
  const body = { body: 'retry me', messageType: 'text', clientMessageId };
  const first = await post(`/conversations/${conversation}/messages`, body);
  assert.equal(first.status, 201);
  const firstJson = (await first.json()) as { message: { id: string }; created: boolean };
  const second = await post(`/conversations/${conversation}/messages`, body);
  assert.equal(second.status, 200, await second.clone().text());
  const secondJson = (await second.json()) as { message: { id: string }; created: boolean };
  assert.equal(secondJson.created, false);
  assert.equal(secondJson.message.id, firstJson.message.id);
  assert.equal(messages.length, 1);
});

test('concurrent duplicate requests create one message', async () => {
  const { messages, post } = fixture();
  const clientMessageId = randomUUID();
  const body = { body: 'race', messageType: 'text', clientMessageId };
  const [a, b] = await Promise.all([
    post(`/conversations/${conversation}/messages`, body),
    post(`/conversations/${conversation}/messages`, body),
  ]);
  assert.ok([200, 201].includes(a.status));
  assert.ok([200, 201].includes(b.status));
  assert.equal(messages.length, 1);
  const ids = new Set(
    [
      ((await a.json()) as { message: { id: string } }).message.id,
      ((await b.json()) as { message: { id: string } }).message.id,
    ],
  );
  assert.equal(ids.size, 1);
});

test('reused id with different payload is rejected', async () => {
  const { messages, post } = fixture();
  const clientMessageId = randomUUID();
  assert.equal(
    (
      await post(`/conversations/${conversation}/messages`, {
        body: 'original',
        clientMessageId,
      })
    ).status,
    201,
  );
  const conflict = await post(`/conversations/${conversation}/messages`, {
    body: 'different',
    clientMessageId,
  });
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.equal(messages.length, 1);
});

test('unauthorized conversation send is rejected', async () => {
  const { post } = fixture();
  const res = await post(
    `/conversations/${conversation}/messages`,
    { body: 'nope', clientMessageId: randomUUID() },
    outsider,
  );
  assert.equal(res.status, 403);
});

test('legacy clients without clientMessageId still create messages', async () => {
  const { messages, post } = fixture();
  const res = await post(`/conversations/${conversation}/messages`, {
    body: 'legacy',
    messageType: 'text',
  });
  assert.equal(res.status, 201);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.clientMessageId ?? null, null);
});

test('media metadata fields remain durable on idempotent text+attachment send', async () => {
  const { messages, post } = fixture();
  const clientMessageId = randomUUID();
  const attachmentUrl = `/api/chat/media?bucket=chat-attachments&objectKey=${org}/${conversation}/file`;
  // Skip attachment existence validation by using absolute https external URL.
  const external = 'https://cdn.example.invalid/file.pdf';
  const body = {
    body: 'doc',
    messageType: 'file' as const,
    attachmentUrl: external,
    attachmentName: 'file.pdf',
    clientMessageId,
    metadata: { storage_path: 'x' },
  };
  assert.equal((await post(`/conversations/${conversation}/messages`, body)).status, 201);
  assert.equal((await post(`/conversations/${conversation}/messages`, body)).status, 200);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.attachmentUrl, external);
  assert.equal(messages[0]?.attachmentName, 'file.pdf');
  void attachmentUrl;
});
