import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createChatRoutes } from '../src/routes/chat.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AuthContext } from '../src/authorization/types.js';
import type {
  ChatMemberRecord,
  ChatMessageRecord,
  ChatStore,
} from '../src/chat/store.js';
import { shouldAdvanceReadCursor } from '../src/chat/read-cursor.js';
import type { OrganizationDirectoryStore } from '../src/organizations/store.js';
import '../src/types/hono.js';

const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const conversation = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const otherConversation = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const reader = '11111111-1111-1111-1111-111111111111';
const peer = '22222222-2222-2222-2222-222222222222';

test('read cursor advances forward only', () => {
  const older = new Date('2026-01-01T00:00:00.000Z');
  const newer = new Date('2026-01-01T00:01:00.000Z');
  assert.equal(
    shouldAdvanceReadCursor({
      currentCursorAt: newer,
      currentMessageId: 'a',
      targetMessageId: 'b',
      targetCreatedAt: older,
    }),
    false,
  );
  assert.equal(
    shouldAdvanceReadCursor({
      currentCursorAt: older,
      currentMessageId: 'a',
      targetMessageId: 'b',
      targetCreatedAt: newer,
    }),
    true,
  );
  assert.equal(
    shouldAdvanceReadCursor({
      currentCursorAt: newer,
      currentMessageId: 'a',
      targetMessageId: 'a',
      targetCreatedAt: newer,
    }),
    false,
  );
});

function fixture() {
  const messages = new Map<string, ChatMessageRecord>();
  const members = new Map<string, ChatMemberRecord>();
  members.set(reader, {
    id: 'm-reader',
    conversationId: conversation,
    userId: reader,
    role: 'member',
    joinedAt: new Date(),
    isMuted: false,
    lastReadMessageId: null,
    lastReadAt: null,
  });
  members.set(peer, {
    id: 'm-peer',
    conversationId: conversation,
    userId: peer,
    role: 'member',
    joinedAt: new Date(),
    isMuted: false,
    lastReadMessageId: null,
    lastReadAt: null,
  });

  const store = {
    isMember: async (id: string, user: string) =>
      id === conversation && (user === reader || user === peer),
    canReadLegacyAttachment: async () => false,
    getConversation: async () => ({
      id: conversation,
      organizationId: org,
      officeId: null,
      title: null,
      type: 'direct' as const,
      createdBy: reader,
      lastMessageAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      disappearingSeconds: null,
    }),
    listMembers: async () => [...members.values()],
    isEitherBlocked: async () => false,
    getMessage: async (_org: string, messageId: string) => messages.get(messageId) ?? null,
    sendMessage: async () => {
      throw new Error('not used');
    },
    markRead: async (input: {
      conversationId: string;
      userId: string;
      messageId: string;
    }) => {
      const target = messages.get(input.messageId);
      if (!target || target.conversationId !== input.conversationId) {
        const { ValidationError } = await import('../src/http/errors.js');
        throw new ValidationError('Message is not part of this conversation.', {
          field: 'messageId',
        });
      }
      const member = members.get(input.userId);
      if (!member) {
        const { NotFoundError } = await import('../src/http/errors.js');
        throw new NotFoundError('CHAT_MEMBER_NOT_FOUND', 'Conversation membership not found.');
      }
      const advanced = shouldAdvanceReadCursor({
        currentCursorAt: member.lastReadAt,
        currentMessageId: member.lastReadMessageId,
        targetMessageId: target.id,
        targetCreatedAt: target.createdAt,
      });
      if (!advanced) return { member, advanced: false };
      const next = {
        ...member,
        lastReadMessageId: target.id,
        lastReadAt: target.createdAt,
      };
      members.set(input.userId, next);
      return { member: next, advanced: true };
    },
    listMessages: async () => [...messages.values()],
    listReactionsForMessages: async () => [],
  } as unknown as ChatStore;

  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user') ?? reader;
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
      files: new MemoryFileStorage(),
      directory: {} as OrganizationDirectoryStore,
    }),
  );

  function addMessage(createdAt: string, conversationId = conversation) {
    const id = randomUUID();
    const row: ChatMessageRecord = {
      id,
      conversationId,
      organizationId: org,
      senderId: peer,
      body: 'hi',
      messageType: 'text',
      replyToMessageId: null,
      attachmentUrl: null,
      attachmentName: null,
      metadata: {},
      isEdited: false,
      isDeleted: false,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    };
    messages.set(id, row);
    return row;
  }

  const postRead = (messageId: string, user = reader) =>
    app.request(`/api/chat/conversations/${conversation}/read`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': user,
      },
      body: JSON.stringify({ messageId }),
    });

  return { addMessage, postRead, members };
}

test('mark-read advances cursor and rejects foreign conversation message', async () => {
  const { addMessage, postRead, members } = fixture();
  const first = addMessage('2026-01-01T00:00:00.000Z');
  const second = addMessage('2026-01-01T00:02:00.000Z');
  const foreign = addMessage('2026-01-01T00:03:00.000Z', otherConversation);

  const firstRes = await postRead(first.id);
  assert.equal(firstRes.status, 200, await firstRes.clone().text());
  const firstJson = (await firstRes.json()) as { advanced: boolean; member: { lastReadMessageId: string } };
  assert.equal(firstJson.advanced, true);
  assert.equal(firstJson.member.lastReadMessageId, first.id);

  const replay = await postRead(first.id);
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { advanced: boolean }).advanced, false);

  const secondRes = await postRead(second.id);
  assert.equal(secondRes.status, 200);
  assert.equal(((await secondRes.json()) as { advanced: boolean }).advanced, true);
  assert.equal(members.get(reader)?.lastReadMessageId, second.id);

  const backward = await postRead(first.id);
  assert.equal(backward.status, 200);
  assert.equal(((await backward.json()) as { advanced: boolean }).advanced, false);
  assert.equal(members.get(reader)?.lastReadMessageId, second.id);

  const bad = await postRead(foreign.id);
  assert.equal(bad.status, 400, await bad.clone().text());
});
