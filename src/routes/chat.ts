import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { listOffset } from '../db/list-bounds.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { readListQuery } from '../http/list-query.js';
import { decodeStrictBase64 } from '../http/base64.js';
import { FIELD_LIMITS } from '../http/limits.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import type { ChatStore, ChatMessageRecord } from '../chat/store.js';
import { chatEnvelope } from '../chat/events.js';
import { getChatRealtimeHub } from '../chat/hub.js';
import {
  chatBucketForContentType,
  chatObjectKey,
} from '../chat/buckets.js';
import { attachmentDisposition, streamStoredMedia } from '../content/media-stream.js';
import type { FileStorage } from '../files/storage.js';
import type { OrganizationDirectoryStore } from '../organizations/store.js';

export type ChatRouteDependencies = {
  store: ChatStore;
  files: FileStorage;
  directory: OrganizationDirectoryStore;
};

function authorizeChat(auth: ReturnType<typeof getAuth>, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: { type: 'chat', organizationId },
  });
  return organizationId;
}

function readMediaObjectKey(raw: string | undefined | null) {
  let value = (raw ?? '').trim();
  if (!value) return '';

  // Query parsers usually decode once; leftover %2F from double-encoding
  // must not break the org/conversation prefix check.
  if (value.includes('%')) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded) value = decoded;
    } catch {
      // keep original
    }
  }

  return value;
}

function parseChatObjectKey(objectKey: string) {
  const [organizationId, conversationId, ...rest] = objectKey.split('/');
  if (!organizationId || !conversationId || rest.length === 0) {
    return null;
  }
  return {
    organizationId,
    conversationId,
    filePart: rest.join('/'),
  };
}

function safeFilename(value: string) {
  const cleaned = value.replace(/[/\\]/g, '_').trim();
  return cleaned.slice(0, 180) || 'file.bin';
}

async function assertCanReadChatMedia(params: {
  store: ChatStore;
  organizationId: string;
  userId: string;
  objectKey: string;
}) {
  const objectKey = readMediaObjectKey(params.objectKey);
  if (!objectKey) {
    throw new NotFoundError('CHAT_MEDIA_NOT_FOUND', 'Media not found.');
  }

  const parsed = parseChatObjectKey(objectKey);
  if (!parsed || parsed.organizationId !== params.organizationId) {
    throw new ForbiddenError(
      'CHAT_FORBIDDEN',
      'This chat file belongs to another organization.',
    );
  }

  // Conversation members can read media in that thread (including 'unscoped' uploads).
  if (parsed.conversationId !== 'unscoped') {
    const member = await params.store.isMember(
      parsed.conversationId,
      params.userId,
    );
    if (!member) {
      throw new ForbiddenError(
        'CHAT_FORBIDDEN',
        'You are not a member of this conversation.',
      );
    }
  }

  return objectKey;
}

function serializeConversation(
  conversation: Awaited<ReturnType<ChatStore['getConversation']>>,
) {
  if (!conversation) return null;
  return {
    id: conversation.id,
    organizationId: conversation.organizationId,
    officeId: conversation.officeId,
    title: conversation.title,
    type: conversation.type,
    createdBy: conversation.createdBy,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    unreadCount: conversation.unreadCount ?? 0,
    memberCount: conversation.memberCount ?? null,
    disappearingSeconds: conversation.disappearingSeconds ?? null,
  };
}

function serializeMember(
  member: Awaited<ReturnType<ChatStore['listMembers']>>[number],
) {
  return {
    id: member.id,
    conversationId: member.conversationId,
    userId: member.userId,
    role: member.role,
    joinedAt: member.joinedAt.toISOString(),
    isMuted: member.isMuted,
    lastReadMessageId: member.lastReadMessageId,
    lastReadAt: member.lastReadAt?.toISOString() ?? null,
    fullName: member.fullName ?? null,
    email: member.email ?? null,
    avatarUrl: member.avatarUrl ?? null,
  };
}

function serializeMessage(message: ChatMessageRecord) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    organizationId: message.organizationId,
    senderId: message.senderId,
    body: message.body,
    messageType: message.messageType,
    replyToMessageId: message.replyToMessageId,
    attachmentUrl: message.attachmentUrl,
    attachmentName: message.attachmentName,
    metadata: message.metadata,
    isEdited: message.isEdited,
    isDeleted: message.isDeleted,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    senderName: message.senderName ?? null,
    senderEmail: message.senderEmail ?? null,
    expiresAt: message.expiresAt?.toISOString() ?? null,
    reactions: (message.reactions ?? []).map((row) => ({
      id: row.id,
      messageId: row.messageId,
      userId: row.userId,
      emoji: row.emoji,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

async function requireMembership(
  store: ChatStore,
  conversationId: string,
  userId: string,
) {
  const ok = await store.isMember(conversationId, userId);
  if (!ok) {
    throw new ForbiddenError(
      'CHAT_NOT_A_MEMBER',
      'You are not a member of this conversation.',
    );
  }
}

export function createChatRoutes(dependencies: ChatRouteDependencies) {
  const routes = new Hono();
  const hub = getChatRealtimeHub();


  routes.get('/users', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const page = readListQuery(c);
    const [members, offices] = await Promise.all([
      dependencies.directory.listMembers(organizationId, {
        limit: page.limit,
        offset: listOffset(Number(c.req.query('offset'))),
      }),
      dependencies.directory.listOffices(organizationId),
    ]);
    const officeNames = new Map(
      offices.map((office) => [office.id, office.name] as const),
    );

    const users = members.members
      .filter(
        (member) =>
          member.userId !== auth.actor.userId && member.status === 'active',
      )
      .map((member) => ({
        id: member.userId,
        email: member.email,
        fullName: member.fullName,
        avatarUrl: member.avatarUrl,
        primaryRole: member.roleKey,
        officeId: member.officeId,
        officeName: member.officeId
          ? officeNames.get(member.officeId) ?? null
          : null,
        username: member.username,
        jobTitle: member.jobTitle,
      }));

    return c.json({ users, hasMore: members.hasMore });
  });

  routes.get('/conversations', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const page = readListQuery(c);
    const conversations = await dependencies.store.listConversations({
      organizationId,
      userId: auth.actor.userId,
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    });
    return c.json({
      conversations: conversations.conversations.map((row) =>
        serializeConversation(row),
      ),
      hasMore: conversations.hasMore,
    });
  });

  routes.post('/conversations/direct', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const body = await readJson(c);
    const otherUserId = requireUuidValue(
      readRequiredText(body.otherUserId ?? body.other_user_id, 'otherUserId'),
      'otherUserId',
    );
    const conversation = await dependencies.store.findOrCreateDirect({
      organizationId,
      createdBy: auth.actor.userId,
      otherUserId,
      officeId: auth.membership.officeId ?? null,
    });
    return c.json({ conversation: serializeConversation(conversation) }, 201);
  });

  routes.post('/conversations/group', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const body = await readJson(c);
    const title = readRequiredText(body.title, 'title');
    const rawMembers = body.memberUserIds ?? body.member_user_ids;
    if (!Array.isArray(rawMembers)) {
      throw new ValidationError('memberUserIds must be an array.', {
        field: 'memberUserIds',
      });
    }
    const memberUserIds = rawMembers.map((value, index) =>
      requireUuidValue(String(value), `memberUserIds[${index}]`),
    );
    const conversation = await dependencies.store.createGroup({
      organizationId,
      createdBy: auth.actor.userId,
      title,
      memberUserIds,
      officeId: auth.membership.officeId ?? null,
    });
    return c.json({ conversation: serializeConversation(conversation) }, 201);
  });

  routes.get('/conversations/:conversationId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    await requireMembership(
      dependencies.store,
      conversationId,
      auth.actor.userId,
    );
    const conversation = await dependencies.store.getConversation(
      organizationId,
      conversationId,
    );
    if (!conversation) {
      throw new ValidationError('Conversation not found.', {
        field: 'conversationId',
      });
    }
    const members = await dependencies.store.listMembers(conversationId);
    return c.json({
      conversation: serializeConversation(conversation),
      members: members.map(serializeMember),
    });
  });

  routes.get('/conversations/:conversationId/messages', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    await requireMembership(
      dependencies.store,
      conversationId,
      auth.actor.userId,
    );
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? new Date(beforeRaw) : null;
    if (beforeRaw && Number.isNaN(before?.getTime())) {
      throw new ValidationError('before must be an ISO timestamp.', {
        field: 'before',
      });
    }
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number(limitRaw) : 50;
    const messages = await dependencies.store.listMessages({
      organizationId,
      conversationId,
      before,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    const reactions = await dependencies.store.listReactionsForMessages(
      messages.map((message) => message.id),
    );
    const reactionsByMessage = new Map<string, typeof reactions>();
    for (const reaction of reactions) {
      const list = reactionsByMessage.get(reaction.messageId) ?? [];
      list.push(reaction);
      reactionsByMessage.set(reaction.messageId, list);
    }
    return c.json({
      messages: messages.map((message) =>
        serializeMessage({
          ...message,
          reactions: reactionsByMessage.get(message.id) ?? [],
        }),
      ),
    });
  });

  routes.post('/conversations/:conversationId/messages', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    await requireMembership(
      dependencies.store,
      conversationId,
      auth.actor.userId,
    );

    const conversation = await dependencies.store.getConversation(
      organizationId,
      conversationId,
    );
    if (!conversation) {
      throw new NotFoundError(
        'CHAT_CONVERSATION_NOT_FOUND',
        'Conversation not found.',
      );
    }

    if (conversation.type === 'direct') {
      const members = await dependencies.store.listMembers(conversationId);
      const other = members.find((member) => member.userId !== auth.actor.userId);
      if (other) {
        const blocked = await dependencies.store.isEitherBlocked({
          organizationId,
          userA: auth.actor.userId,
          userB: other.userId,
        });
        if (blocked) {
          throw new ForbiddenError(
            'CHAT_USER_BLOCKED',
            'Messaging is blocked between these users.',
          );
        }
      }
    }

    const body = await readJson(c);
    const disappearingSeconds = conversation.disappearingSeconds ?? null;
    const expiresAt =
      disappearingSeconds != null
        ? new Date(Date.now() + disappearingSeconds * 1000)
        : null;
    const message = await dependencies.store.sendMessage({
      organizationId,
      conversationId,
      senderId: auth.actor.userId,
      body: readOptionalString(body.body, 'body'),
      messageType:
        (readOptionalString(body.messageType ?? body.message_type, 'messageType') as
          | 'text'
          | 'image'
          | 'audio'
          | 'file'
          | 'system'
          | undefined) ?? 'text',
      replyToMessageId: body.replyToMessageId
        ? requireUuidValue(String(body.replyToMessageId), 'replyToMessageId')
        : body.reply_to_message_id
          ? requireUuidValue(String(body.reply_to_message_id), 'replyToMessageId')
          : null,
      attachmentUrl: readOptionalString(
        body.attachmentUrl ?? body.attachment_url,
        'attachmentUrl',
        2_048,
      ),
      attachmentName: readOptionalString(
        body.attachmentName ?? body.attachment_name,
        'attachmentName',
        FIELD_LIMITS.filename,
      ),
      metadata:
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : {},
      expiresAt,
    });

    await hub.publishToConversation(
      conversationId,
      chatEnvelope(
        'message.created',
        { message: serializeMessage(message) },
        { conversationId, organizationId },
      ),
    );

    return c.json({ message: serializeMessage(message) }, 201);
  });

  routes.patch('/messages/:messageId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const messageId = requireUuidValue(c.req.param('messageId'), 'messageId');
    const body = await readJson(c);
    const text = readRequiredText(body.body, 'body');
    const existing = await dependencies.store.getMessage(
      organizationId,
      messageId,
    );
    if (!existing) {
      throw new ValidationError('Message not found.', { field: 'messageId' });
    }
    await requireMembership(
      dependencies.store,
      existing.conversationId,
      auth.actor.userId,
    );
    const message = await dependencies.store.editMessage({
      organizationId,
      messageId,
      senderId: auth.actor.userId,
      body: text,
    });
    await hub.publishToConversation(
      message.conversationId,
      chatEnvelope(
        'message.updated',
        { message: serializeMessage(message) },
        { conversationId: message.conversationId, organizationId },
      ),
    );
    return c.json({ message: serializeMessage(message) });
  });

  routes.delete('/messages/:messageId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const messageId = requireUuidValue(c.req.param('messageId'), 'messageId');
    const existing = await dependencies.store.getMessage(
      organizationId,
      messageId,
    );
    if (!existing) {
      throw new ValidationError('Message not found.', { field: 'messageId' });
    }
    await requireMembership(
      dependencies.store,
      existing.conversationId,
      auth.actor.userId,
    );
    const allowAny =
      auth.membership.isAdminRole ||
      auth.membership.isManagerRole ||
      auth.membership.roleKey === 'it';
    const message = await dependencies.store.softDeleteMessage({
      organizationId,
      messageId,
      actorUserId: auth.actor.userId,
      allowAny,
    });
    await hub.publishToConversation(
      message.conversationId,
      chatEnvelope(
        'message.deleted',
        { message: serializeMessage(message) },
        { conversationId: message.conversationId, organizationId },
      ),
    );
    return c.json({ message: serializeMessage(message) });
  });

  routes.post('/conversations/:conversationId/read', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    await requireMembership(
      dependencies.store,
      conversationId,
      auth.actor.userId,
    );
    const body = await readJson(c);
    const messageId = requireUuidValue(
      String(body.messageId ?? body.message_id),
      'messageId',
    );
    const member = await dependencies.store.markRead({
      conversationId,
      userId: auth.actor.userId,
      messageId,
    });
    await hub.publishToConversation(
      conversationId,
      chatEnvelope(
        'read_receipt',
        {
          userId: auth.actor.userId,
          messageId,
          readAt: member.lastReadAt?.toISOString() ?? null,
        },
        { conversationId, organizationId },
      ),
    );
    return c.json({ member: serializeMember(member) });
  });

  routes.get('/messages/:messageId/reactions', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const messageId = requireUuidValue(c.req.param('messageId'), 'messageId');
    const existing = await dependencies.store.getMessage(
      organizationId,
      messageId,
    );
    if (!existing) {
      throw new ValidationError('Message not found.', { field: 'messageId' });
    }
    await requireMembership(
      dependencies.store,
      existing.conversationId,
      auth.actor.userId,
    );
    const reactions = await dependencies.store.listReactions(messageId);
    return c.json({
      reactions: reactions.map((row) => ({
        id: row.id,
        messageId: row.messageId,
        userId: row.userId,
        emoji: row.emoji,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  });

  routes.post('/messages/:messageId/reactions', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const messageId = requireUuidValue(c.req.param('messageId'), 'messageId');
    const existing = await dependencies.store.getMessage(
      organizationId,
      messageId,
    );
    if (!existing) {
      throw new ValidationError('Message not found.', { field: 'messageId' });
    }
    await requireMembership(
      dependencies.store,
      existing.conversationId,
      auth.actor.userId,
    );
    const body = await readJson(c);
    const emoji = readRequiredText(body.emoji, 'emoji');
    const result = await dependencies.store.toggleReaction({
      messageId,
      userId: auth.actor.userId,
      emoji,
    });
    await hub.publishToConversation(
      existing.conversationId,
      chatEnvelope(
        result.added ? 'reaction.added' : 'reaction.removed',
        {
          messageId,
          userId: auth.actor.userId,
          emoji,
          reaction: result.reaction
            ? {
                id: result.reaction.id,
                messageId: result.reaction.messageId,
                userId: result.reaction.userId,
                emoji: result.reaction.emoji,
                createdAt: result.reaction.createdAt.toISOString(),
              }
            : null,
        },
        { conversationId: existing.conversationId, organizationId },
      ),
    );
    return c.json({ added: result.added, reaction: result.reaction });
  });


  routes.post('/attachments', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const body = await readJson(c);

    const fileName = safeFilename(
      readRequiredText(body.fileName, 'fileName', FIELD_LIMITS.filename),
    );
    const contentType =
      readOptionalString(body.contentType, 'contentType', FIELD_LIMITS.contentType) ??
      'application/octet-stream';
    const conversationId = body.conversationId
      ? requireUuidValue(body.conversationId, 'conversationId')
      : null;

    if (conversationId) {
      await requireMembership(
        dependencies.store,
        conversationId,
        auth.actor.userId,
      );
    }

    const bytes = decodeStrictBase64(
      body.contentBase64,
      'contentBase64',
      c.get('limits').maxAttachmentBytes,
    );

    const fileId = randomUUID();
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    const bucket = chatBucketForContentType(contentType);
    const objectKey = chatObjectKey({
      organizationId,
      conversationId: conversationId ?? 'unscoped',
      fileId,
      filename: fileName,
    });

    await dependencies.files.ensureBucket?.(bucket);
    await dependencies.files.putObject({
      bucket,
      objectKey,
      body: bytes,
      contentType,
    });

    const mediaPath = `/api/chat/media?bucket=${encodeURIComponent(bucket)}&objectKey=${encodeURIComponent(objectKey)}`;

    return c.json(
      {
        attachment: {
          id: fileId,
          bucket,
          objectKey,
          fileName,
          contentType,
          byteSize: bytes.byteLength,
          checksumSha256,
          url: mediaPath,
        },
      },
      201,
    );
  });

  routes.get('/media', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const bucket = (c.req.query('bucket') ?? '').trim();
    const objectKey = await assertCanReadChatMedia({
      store: dependencies.store,
      organizationId,
      userId: auth.actor.userId,
      objectKey: c.req.query('objectKey') ?? '',
    });

    if (bucket !== 'chat-attachments' && bucket !== 'chat-images') {
      throw new NotFoundError('CHAT_MEDIA_NOT_FOUND', 'Media not found.');
    }

    const fileName = objectKey.split('/').pop() ?? 'file.bin';
    return streamStoredMedia({
      files: dependencies.files,
      bucket,
      objectKey,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, max-age=3600',
      contentDisposition: attachmentDisposition('inline', safeFilename(fileName)),
      notFoundCode: 'CHAT_MEDIA_NOT_FOUND',
      notFoundMessage: 'Media not found.',
    });
  });


  routes.get('/media/:bucket/*', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const bucket = decodeURIComponent(c.req.param('bucket') ?? '');
    const splat = c.req.param('*') ?? '';
    const rawKey = splat
      .split('/')
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join('/');
    const objectKey = await assertCanReadChatMedia({
      store: dependencies.store,
      organizationId,
      userId: auth.actor.userId,
      objectKey: rawKey,
    });

    if (bucket !== 'chat-attachments' && bucket !== 'chat-images') {
      throw new NotFoundError('CHAT_MEDIA_NOT_FOUND', 'Media not found.');
    }

    const fileName = objectKey.split('/').pop() ?? 'file.bin';
    return streamStoredMedia({
      files: dependencies.files,
      bucket,
      objectKey,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, max-age=3600',
      contentDisposition: attachmentDisposition('inline', safeFilename(fileName)),
      notFoundCode: 'CHAT_MEDIA_NOT_FOUND',
      notFoundMessage: 'Media not found.',
    });
  });

  routes.delete('/conversations/:conversationId/membership', async (c) => {
    const auth = getAuth(c);
    authorizeChat(auth, 'chat.write');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    await requireMembership(
      dependencies.store,
      conversationId,
      auth.actor.userId,
    );
    const left = await dependencies.store.leaveConversation({
      conversationId,
      userId: auth.actor.userId,
    });
    if (!left) {
      throw new NotFoundError(
        'CHAT_MEMBER_NOT_FOUND',
        'Conversation membership not found.',
      );
    }
    return c.json({ ok: true });
  });

  routes.patch('/conversations/:conversationId/disappearing', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    await requireMembership(
      dependencies.store,
      conversationId,
      auth.actor.userId,
    );
    const body = await readJson(c);
    const rawSeconds = body.seconds ?? body.disappearing_seconds;
    const seconds =
      rawSeconds === null || rawSeconds === undefined || rawSeconds === ''
        ? null
        : Number(rawSeconds);
    if (seconds != null && !Number.isFinite(seconds)) {
      throw new ValidationError('seconds must be a number or null.', {
        field: 'seconds',
      });
    }
    const conversation = await dependencies.store.updateDisappearingSeconds({
      organizationId,
      conversationId,
      seconds,
    });
    return c.json({ conversation: serializeConversation(conversation) });
  });

  routes.get('/blocks', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const blockedUserIds = await dependencies.store.listBlockedUserIds({
      organizationId,
      blockerId: auth.actor.userId,
    });
    return c.json({ blockedUserIds });
  });

  routes.post('/blocks', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const body = await readJson(c);
    const blockedId = requireUuidValue(
      String(body.blockedId ?? body.blocked_id),
      'blockedId',
    );
    const conversationIdRaw = body.conversationId ?? body.conversation_id;
    const conversationId = conversationIdRaw
      ? requireUuidValue(String(conversationIdRaw), 'conversationId')
      : null;
    await dependencies.store.blockUser({
      organizationId,
      blockerId: auth.actor.userId,
      blockedId,
      conversationId,
    });
    return c.json({ ok: true }, 201);
  });

  routes.delete('/blocks/:blockedId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const blockedId = requireUuidValue(c.req.param('blockedId'), 'blockedId');
    await dependencies.store.unblockUser({
      organizationId,
      blockerId: auth.actor.userId,
      blockedId,
    });
    return c.json({ ok: true });
  });

  routes.put('/keys/material', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const body = await readJson(c);
    const material = await dependencies.store.upsertUserKeyMaterial({
      organizationId,
      userId: auth.actor.userId,
      keyFingerprint: readRequiredText(body.keyFingerprint ?? body.key_fingerprint, 'keyFingerprint', 256),
      publicWrapKey: readRequiredText(body.publicWrapKey ?? body.public_wrap_key, 'publicWrapKey', 8192),
      keyVersion: Number(body.keyVersion ?? body.key_version ?? 1) || 1,
    });
    return c.json({
      material: {
        userId: material.userId,
        organizationId: material.organizationId,
        keyFingerprint: material.keyFingerprint,
        publicWrapKey: material.publicWrapKey,
        keyVersion: material.keyVersion,
        updatedAt: material.updatedAt.toISOString(),
      },
    });
  });

  routes.get('/keys/material/me', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const material = await dependencies.store.getUserKeyMaterial({
      organizationId,
      userId: auth.actor.userId,
    });
    return c.json({
      material: material
        ? {
            userId: material.userId,
            organizationId: material.organizationId,
            keyFingerprint: material.keyFingerprint,
            publicWrapKey: material.publicWrapKey,
            keyVersion: material.keyVersion,
            updatedAt: material.updatedAt.toISOString(),
          }
        : null,
    });
  });

  routes.get('/conversations/:conversationId/keys/peers', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    const peers = await dependencies.store.listPeerWrapKeys({
      organizationId,
      conversationId,
      requesterUserId: auth.actor.userId,
    });
    return c.json({
      peers: peers.map((peer) => ({
        userId: peer.userId,
        publicWrapKey: peer.publicWrapKey,
        keyVersion: peer.keyVersion,
      })),
    });
  });

  routes.put('/conversations/:conversationId/keys/envelopes', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.write');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    const body = await readJson(c);
    const targetUserId = requireUuidValue(
      String(body.userId ?? body.user_id),
      'userId',
    );
    const envelope = await dependencies.store.upsertConversationKeyEnvelope({
      organizationId,
      conversationId,
      actorUserId: auth.actor.userId,
      targetUserId,
      wrappedKey: readRequiredText(body.wrappedKey ?? body.wrapped_key, 'wrappedKey', 8192),
      keyVersion: Number(body.keyVersion ?? body.key_version ?? 1) || 1,
    });
    return c.json({
      envelope: {
        id: envelope.id,
        organizationId: envelope.organizationId,
        conversationId: envelope.conversationId,
        userId: envelope.userId,
        wrappedKey: envelope.wrappedKey,
        keyVersion: envelope.keyVersion,
        updatedAt: envelope.updatedAt.toISOString(),
      },
    });
  });

  routes.get('/conversations/:conversationId/keys/envelopes/me', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChat(auth, 'chat.read');
    const conversationId = requireUuidValue(
      c.req.param('conversationId'),
      'conversationId',
    );
    await requireMembership(
      dependencies.store,
      conversationId,
      auth.actor.userId,
    );
    const keyVersion = Number(c.req.query('keyVersion') ?? 1) || 1;
    const envelope = await dependencies.store.getOwnConversationKeyEnvelope({
      organizationId,
      conversationId,
      userId: auth.actor.userId,
      keyVersion,
    });
    return c.json({
      envelope: envelope
        ? {
            id: envelope.id,
            organizationId: envelope.organizationId,
            conversationId: envelope.conversationId,
            userId: envelope.userId,
            wrappedKey: envelope.wrappedKey,
            keyVersion: envelope.keyVersion,
            updatedAt: envelope.updatedAt.toISOString(),
          }
        : null,
    });
  });

  return routes;
}
