import { listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import {
  assertClientMessageRetryAllowed,
  normalizeClientMessagePayload,
} from './client-message-idempotency.js';
import { shouldAdvanceReadCursor } from './read-cursor.js';
import type {
  ChatConversationRecord,
  ChatMemberRecord,
  ChatMessageRecord,
  ChatReactionRecord,
  ChatStore,
  CreateDirectConversationInput,
  CreateGroupConversationInput,
  ListConversationsInput,
  ListMessagesInput,
  SendMessageInput,
  SendMessageResult,
} from './store.js';

type ConversationRow = {
  id: string;
  organization_id: string;
  office_id: string | null;
  title: string | null;
  type: ChatConversationRecord['type'];
  created_by: string;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
  unread_count?: string | number | null;
  member_count?: string | number | null;
  disappearing_seconds?: number | null;
  last_message_id?: string | null;
  last_message_body?: string | null;
  last_message_type?: ChatConversationRecord['lastMessageType'];
  last_message_sender_id?: string | null;
  last_message_attachment_name?: string | null;
};

type MemberRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  role: ChatMemberRecord['role'];
  joined_at: Date;
  is_muted: boolean;
  last_read_message_id: string | null;
  last_read_at: Date | null;
  full_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  organization_id: string;
  sender_id: string;
  body: string | null;
  message_type: ChatMessageRecord['messageType'];
  reply_to_message_id: string | null;
  attachment_url: string | null;
  attachment_name: string | null;
  metadata: Record<string, unknown> | null;
  is_edited: boolean;
  is_deleted: boolean;
  created_at: Date;
  updated_at: Date;
  sender_name?: string | null;
  sender_email?: string | null;
  expires_at?: Date | null;
  client_message_id?: string | null;
};

type ReactionRow = {
  id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: Date;
};

function mapConversation(row: ConversationRow): ChatConversationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    title: row.title,
    type: row.type,
    createdBy: row.created_by,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unreadCount:
      row.unread_count == null ? undefined : Number(row.unread_count),
    memberCount:
      row.member_count == null ? undefined : Number(row.member_count),
    disappearingSeconds: row.disappearing_seconds ?? null,
    lastMessageId: row.last_message_id ?? null,
    lastMessageBody: row.last_message_body ?? null,
    lastMessageType: row.last_message_type ?? null,
    lastMessageSenderId: row.last_message_sender_id ?? null,
    lastMessageAttachmentName: row.last_message_attachment_name ?? null,
  };
}

function mapMember(row: MemberRow): ChatMemberRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at,
    isMuted: row.is_muted,
    lastReadMessageId: row.last_read_message_id,
    lastReadAt: row.last_read_at,
    fullName: row.full_name ?? null,
    email: row.email ?? null,
    avatarUrl: row.avatar_url ?? null,
  };
}

function mapMessage(row: MessageRow): ChatMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    organizationId: row.organization_id,
    senderId: row.sender_id,
    body: row.body,
    messageType: row.message_type,
    replyToMessageId: row.reply_to_message_id,
    attachmentUrl: row.attachment_url,
    attachmentName: row.attachment_name,
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
    isEdited: row.is_edited,
    isDeleted: row.is_deleted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    senderName: row.sender_name ?? null,
    senderEmail: row.sender_email ?? null,
    expiresAt: row.expires_at ?? null,
    clientMessageId: row.client_message_id ?? null,
  };
}

function mapReaction(row: ReactionRow): ChatReactionRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: row.created_at,
  };
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export class PostgresChatStore implements ChatStore {
  async canReadLegacyAttachment(organizationId: string, userId: string, objectKey: string) {
    const urls = ['chat-images', 'chat-attachments'].flatMap(bucket => [
      `/api/chat/media?bucket=${bucket}&objectKey=${encodeURIComponent(objectKey)}`,
      `/api/chat/media/${bucket}/${objectKey}`,
    ]);
    const result = await db.query(`SELECT 1 FROM chat.messages m
      JOIN chat.conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
      WHERE m.organization_id = $1 AND m.is_deleted = FALSE
        AND (m.expires_at IS NULL OR m.expires_at > NOW())
        AND m.attachment_url = ANY($3::text[]) LIMIT 1`,
    [organizationId, userId, urls]);
    return result.rows.length > 0;
  }

  async listConversations(input: ListConversationsInput) {
    const limit = listLimit(input.limit);
    const result = await db.query<ConversationRow>(
      `
        SELECT
          c.*,
          (
            SELECT COUNT(*)::int
            FROM chat.conversation_members cm2
            WHERE cm2.conversation_id = c.id
          ) AS member_count,
          (
            SELECT COUNT(*)::int
            FROM chat.messages m
            WHERE m.conversation_id = c.id
              AND m.is_deleted = FALSE
              AND m.sender_id <> $2
              AND (m.expires_at IS NULL OR m.expires_at > NOW())
              AND (
                cm.last_read_at IS NULL
                OR m.created_at > cm.last_read_at
              )
          ) AS unread_count,
          lm.id AS last_message_id,
          lm.body AS last_message_body,
          lm.message_type AS last_message_type,
          lm.sender_id AS last_message_sender_id,
          lm.attachment_name AS last_message_attachment_name
        FROM chat.conversations c
        JOIN chat.conversation_members cm
          ON cm.conversation_id = c.id
         AND cm.user_id = $2
        LEFT JOIN LATERAL (
          SELECT m.id, m.body, m.message_type, m.sender_id, m.attachment_name
          FROM chat.messages m
          WHERE m.conversation_id = c.id
            AND m.is_deleted = FALSE
            AND (m.expires_at IS NULL OR m.expires_at > NOW())
          ORDER BY m.created_at DESC
          LIMIT 1
        ) lm ON TRUE
        WHERE c.organization_id = $1
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id DESC
        LIMIT $3 OFFSET $4
      `,
      [
        input.organizationId,
        input.userId,
        limit + 1,
        listOffset(input.offset),
      ],
    );
    const paged = pageOf(result.rows.map(mapConversation), limit);
    return { conversations: paged.rows, hasMore: paged.hasMore };
  }

  async getConversation(organizationId: string, conversationId: string) {
    const result = await db.query<ConversationRow>(
      `
        SELECT
          c.*,
          lm.id AS last_message_id,
          lm.body AS last_message_body,
          lm.message_type AS last_message_type,
          lm.sender_id AS last_message_sender_id,
          lm.attachment_name AS last_message_attachment_name
        FROM chat.conversations c
        LEFT JOIN LATERAL (
          SELECT m.id, m.body, m.message_type, m.sender_id, m.attachment_name
          FROM chat.messages m
          WHERE m.conversation_id = c.id
            AND m.is_deleted = FALSE
            AND (m.expires_at IS NULL OR m.expires_at > NOW())
          ORDER BY m.created_at DESC
          LIMIT 1
        ) lm ON TRUE
        WHERE c.id = $1 AND c.organization_id = $2
        LIMIT 1
      `,
      [conversationId, organizationId],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async listMembers(conversationId: string) {
    const result = await db.query<MemberRow>(
      `
        SELECT
          m.*,
          p.full_name,
          u.email,
          p.avatar_url
        FROM chat.conversation_members m
        JOIN identity.users u ON u.id = m.user_id
        LEFT JOIN identity.user_profiles p ON p.user_id = m.user_id
        WHERE m.conversation_id = $1
        ORDER BY m.joined_at ASC
      `,
      [conversationId],
    );
    return result.rows.map(mapMember);
  }

  async isMember(
    conversationId: string,
    userId: string,
    organizationId?: string,
  ) {
    const result = await db.query<{ ok: number }>(
      organizationId
        ? `
        SELECT 1 AS ok
        FROM chat.conversation_members m
        INNER JOIN chat.conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1
          AND m.user_id = $2
          AND c.organization_id = $3
        LIMIT 1
      `
        : `
        SELECT 1 AS ok
        FROM chat.conversation_members
        WHERE conversation_id = $1 AND user_id = $2
        LIMIT 1
      `,
      organizationId
        ? [conversationId, userId, organizationId]
        : [conversationId, userId],
    );
    return Boolean(result.rows[0]);
  }

  private async assertActiveOrgMembers(
    client: {
      query: (
        sql: string,
        params?: unknown[],
      ) => Promise<{ rows: Array<{ user_id: string }> }>;
    },
    organizationId: string,
    userIds: string[],
  ) {
    const unique = [...new Set(userIds)];
    const result = await client.query(
      `
        SELECT user_id
        FROM organizations.memberships
        WHERE organization_id = $1
          AND status = 'active'
          AND user_id = ANY($2::uuid[])
      `,
      [organizationId, unique],
    );
    if (result.rows.length !== unique.length) {
      throw new ValidationError(
        'Every chat member must be an active organization member.',
        { field: 'memberUserIds' },
      );
    }
  }

  async findOrCreateDirect(input: CreateDirectConversationInput) {
    if (input.createdBy === input.otherUserId) {
      throw new ValidationError('Cannot start a direct chat with yourself.', {
        field: 'otherUserId',
      });
    }
    const [userA, userB] = orderedPair(input.createdBy, input.otherUserId);

    const existing = await db.query<{ conversation_id: string }>(
      `
        SELECT conversation_id
        FROM chat.direct_pairs
        WHERE organization_id = $1
          AND user_a = $2
          AND user_b = $3
        LIMIT 1
      `,
      [input.organizationId, userA, userB],
    );
    if (existing.rows[0]) {
      const conversation = await this.getConversation(
        input.organizationId,
        existing.rows[0].conversation_id,
      );
      if (conversation) return conversation;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await this.assertActiveOrgMembers(client, input.organizationId, [
        input.createdBy,
        input.otherUserId,
      ]);
      const created = await client.query<ConversationRow>(
        `
          INSERT INTO chat.conversations (
            organization_id, office_id, title, type, created_by
          )
          VALUES ($1, $2, NULL, 'direct', $3)
          RETURNING *
        `,
        [input.organizationId, input.officeId ?? null, input.createdBy],
      );
      const conversation = created.rows[0]!;
      await client.query(
        `
          INSERT INTO chat.conversation_members (conversation_id, user_id, role)
          VALUES
            ($1, $2, 'owner'),
            ($1, $3, 'member')
        `,
        [conversation.id, input.createdBy, input.otherUserId],
      );
      await client.query(
        `
          INSERT INTO chat.direct_pairs (
            organization_id, user_a, user_b, conversation_id
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (organization_id, user_a, user_b)
          DO NOTHING
        `,
        [input.organizationId, userA, userB, conversation.id],
      );
      await client.query('COMMIT');

      const raced = await db.query<{ conversation_id: string }>(
        `
          SELECT conversation_id
          FROM chat.direct_pairs
          WHERE organization_id = $1 AND user_a = $2 AND user_b = $3
        `,
        [input.organizationId, userA, userB],
      );
      const id = raced.rows[0]?.conversation_id ?? conversation.id;
      const finalConversation = await this.getConversation(
        input.organizationId,
        id,
      );
      if (!finalConversation) {
        throw new ConflictError('CHAT_DIRECT_CREATE_FAILED', 'Could not create direct chat.');
      }
      return finalConversation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createGroup(input: CreateGroupConversationInput) {
    const title = input.title.trim();
    if (!title) {
      throw new ValidationError('Group title is required.', { field: 'title' });
    }
    const memberIds = Array.from(
      new Set([input.createdBy, ...input.memberUserIds]),
    );
    if (memberIds.length < 2) {
      throw new ValidationError('A group needs at least two members.', {
        field: 'memberUserIds',
      });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await this.assertActiveOrgMembers(
        client,
        input.organizationId,
        memberIds,
      );
      const created = await client.query<ConversationRow>(
        `
          INSERT INTO chat.conversations (
            organization_id, office_id, title, type, created_by
          )
          VALUES ($1, $2, $3, 'group', $4)
          RETURNING *
        `,
        [
          input.organizationId,
          input.officeId ?? null,
          title,
          input.createdBy,
        ],
      );
      const conversation = created.rows[0]!;
      for (const userId of memberIds) {
        await client.query(
          `
            INSERT INTO chat.conversation_members (conversation_id, user_id, role)
            VALUES ($1, $2, $3)
          `,
          [
            conversation.id,
            userId,
            userId === input.createdBy ? 'owner' : 'member',
          ],
        );
      }
      await client.query('COMMIT');
      return mapConversation(conversation);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listMessages(input: ListMessagesInput) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const result = await db.query<MessageRow>(
      `
        SELECT
          m.*,
          p.full_name AS sender_name,
          u.email AS sender_email
        FROM chat.messages m
        JOIN identity.users u ON u.id = m.sender_id
        LEFT JOIN identity.user_profiles p ON p.user_id = m.sender_id
        WHERE m.organization_id = $1
          AND m.conversation_id = $2
          AND (m.expires_at IS NULL OR m.expires_at > NOW())
          AND ($3::timestamptz IS NULL OR m.created_at < $3)
        ORDER BY m.created_at DESC
        LIMIT $4
      `,
      [
        input.organizationId,
        input.conversationId,
        input.before ?? null,
        limit,
      ],
    );
    return result.rows.map(mapMessage).reverse();
  }

  async getMessage(organizationId: string, messageId: string) {
    const result = await db.query<MessageRow>(
      `
        SELECT
          m.*,
          p.full_name AS sender_name,
          u.email AS sender_email
        FROM chat.messages m
        JOIN identity.users u ON u.id = m.sender_id
        LEFT JOIN identity.user_profiles p ON p.user_id = m.sender_id
        WHERE m.id = $1 AND m.organization_id = $2
        LIMIT 1
      `,
      [messageId, organizationId],
    );
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const messageType = input.messageType ?? 'text';
    const body = input.body?.trim() || null;
    if (
      messageType === 'text' &&
      !body &&
      !input.attachmentUrl
    ) {
      throw new ValidationError('Message cannot be empty.', { field: 'body' });
    }

    const clientMessageId = input.clientMessageId?.trim() || null;
    const incomingPayload = normalizeClientMessagePayload({
      body,
      messageType,
      replyToMessageId: input.replyToMessageId,
      attachmentUrl: input.attachmentUrl,
      attachmentName: input.attachmentName,
    });

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const insertParams = [
        input.conversationId,
        input.organizationId,
        input.senderId,
        body,
        messageType,
        input.replyToMessageId ?? null,
        input.attachmentUrl ?? null,
        input.attachmentName ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.expiresAt ?? null,
        clientMessageId,
      ] as const;

      const inserted = clientMessageId
        ? await client.query<MessageRow>(
            `
              INSERT INTO chat.messages (
                conversation_id,
                organization_id,
                sender_id,
                body,
                message_type,
                reply_to_message_id,
                attachment_url,
                attachment_name,
                metadata,
                expires_at,
                client_message_id
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
              ON CONFLICT (conversation_id, sender_id, client_message_id)
                WHERE client_message_id IS NOT NULL
              DO NOTHING
              RETURNING *
            `,
            [...insertParams],
          )
        : await client.query<MessageRow>(
            `
              INSERT INTO chat.messages (
                conversation_id,
                organization_id,
                sender_id,
                body,
                message_type,
                reply_to_message_id,
                attachment_url,
                attachment_name,
                metadata,
                expires_at,
                client_message_id
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
              RETURNING *
            `,
            [...insertParams],
          );

      if (inserted.rows[0]) {
        await client.query(
          `
            UPDATE chat.conversations
            SET last_message_at = $2, updated_at = NOW()
            WHERE id = $1
          `,
          [input.conversationId, inserted.rows[0].created_at],
        );
        await client.query('COMMIT');
        const message = await this.getMessage(
          input.organizationId,
          inserted.rows[0].id,
        );
        if (!message) {
          throw new NotFoundError('CHAT_MESSAGE_MISSING', 'Message not found after insert.');
        }
        return { message, created: true };
      }

    
      if (!clientMessageId) {
        throw new ConflictError(
          'CHAT_MESSAGE_INSERT_FAILED',
          'Could not persist chat message.',
        );
      }

      const existingResult = await client.query<MessageRow>(
        `
          SELECT
            m.*,
            p.full_name AS sender_name,
            u.email AS sender_email
          FROM chat.messages m
          JOIN identity.users u ON u.id = m.sender_id
          LEFT JOIN identity.user_profiles p ON p.user_id = m.sender_id
          WHERE m.conversation_id = $1
            AND m.sender_id = $2
            AND m.client_message_id = $3
          LIMIT 1
        `,
        [input.conversationId, input.senderId, clientMessageId],
      );
      await client.query('COMMIT');

      const existingRow = existingResult.rows[0];
      if (!existingRow) {
        throw new ConflictError(
          'CHAT_MESSAGE_INSERT_FAILED',
          'Could not persist chat message.',
        );
      }

      const existing = mapMessage(existingRow);
      assertClientMessageRetryAllowed(
        normalizeClientMessagePayload(existing),
        incomingPayload,
      );
      return { message: existing, created: false };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
      }

      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === '23505' &&
        clientMessageId
      ) {
        const existing = await this.findMessageByClientId({
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          senderId: input.senderId,
          clientMessageId,
        });
        if (existing) {
          assertClientMessageRetryAllowed(
            normalizeClientMessagePayload(existing),
            incomingPayload,
          );
          return { message: existing, created: false };
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async findMessageByClientId(input: {
    organizationId: string;
    conversationId: string;
    senderId: string;
    clientMessageId: string;
  }) {
    const result = await db.query<MessageRow>(
      `
        SELECT
          m.*,
          p.full_name AS sender_name,
          u.email AS sender_email
        FROM chat.messages m
        JOIN identity.users u ON u.id = m.sender_id
        LEFT JOIN identity.user_profiles p ON p.user_id = m.sender_id
        WHERE m.organization_id = $1
          AND m.conversation_id = $2
          AND m.sender_id = $3
          AND m.client_message_id = $4
        LIMIT 1
      `,
      [
        input.organizationId,
        input.conversationId,
        input.senderId,
        input.clientMessageId,
      ],
    );
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  async editMessage(input: {
    organizationId: string;
    messageId: string;
    senderId: string;
    body: string;
  }) {
    const body = input.body.trim();
    if (!body) {
      throw new ValidationError('Message cannot be empty.', { field: 'body' });
    }
    const result = await db.query<MessageRow>(
      `
        UPDATE chat.messages
        SET body = $4, is_edited = TRUE, updated_at = NOW()
        WHERE id = $1
          AND organization_id = $2
          AND sender_id = $3
          AND is_deleted = FALSE
          AND message_type = 'text'
        RETURNING *
      `,
      [input.messageId, input.organizationId, input.senderId, body],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('CHAT_MESSAGE_NOT_FOUND', 'Message not found.');
    }
    const message = await this.getMessage(input.organizationId, input.messageId);
    if (!message) {
      throw new NotFoundError('CHAT_MESSAGE_NOT_FOUND', 'Message not found.');
    }
    return message;
  }

  async softDeleteMessage(input: {
    organizationId: string;
    messageId: string;
    actorUserId: string;
    allowAny?: boolean;
  }) {
    const result = await db.query<MessageRow>(
      `
        UPDATE chat.messages
        SET
          is_deleted = TRUE,
          body = NULL,
          attachment_url = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND organization_id = $2
          AND is_deleted = FALSE
          AND ($4::boolean OR sender_id = $3)
        RETURNING *
      `,
      [
        input.messageId,
        input.organizationId,
        input.actorUserId,
        Boolean(input.allowAny),
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('CHAT_MESSAGE_NOT_FOUND', 'Message not found.');
    }
    const message = await this.getMessage(input.organizationId, input.messageId);
    if (!message) {
      throw new NotFoundError('CHAT_MESSAGE_NOT_FOUND', 'Message not found.');
    }
    return message;
  }

  async markRead(input: {
    conversationId: string;
    userId: string;
    messageId: string;
  }) {
    const messageResult = await db.query<{
      id: string;
      conversation_id: string;
      created_at: Date;
      is_deleted: boolean;
    }>(
      `
        SELECT id, conversation_id, created_at, is_deleted
        FROM chat.messages
        WHERE id = $1
        LIMIT 1
      `,
      [input.messageId],
    );
    const target = messageResult.rows[0];
    if (!target || target.conversation_id !== input.conversationId) {
      throw new ValidationError('Message is not part of this conversation.', {
        field: 'messageId',
      });
    }

    const memberResult = await db.query<MemberRow>(
      `
        SELECT *
        FROM chat.conversation_members
        WHERE conversation_id = $1
          AND user_id = $2
        LIMIT 1
      `,
      [input.conversationId, input.userId],
    );
    const current = memberResult.rows[0];
    if (!current) {
      throw new NotFoundError(
        'CHAT_MEMBER_NOT_FOUND',
        'Conversation membership not found.',
      );
    }

    let cursorAt: Date | null = current.last_read_at;
    if (current.last_read_message_id) {
      const cursorMessage = await db.query<{ created_at: Date }>(
        `
          SELECT created_at
          FROM chat.messages
          WHERE id = $1
          LIMIT 1
        `,
        [current.last_read_message_id],
      );
      if (cursorMessage.rows[0]) {
        cursorAt = cursorMessage.rows[0].created_at;
      }
    }

    const advanced = shouldAdvanceReadCursor({
      currentCursorAt: cursorAt,
      currentMessageId: current.last_read_message_id,
      targetMessageId: target.id,
      targetCreatedAt: target.created_at,
    });

    if (!advanced) {
      return { member: mapMember(current), advanced: false };
    }

    // Anchor last_read_at to the message timestamp (not NOW()) so unread counts
    // stay consistent with the message cursor after clock skew / delayed marks.
    const updated = await db.query<MemberRow>(
      `
        UPDATE chat.conversation_members
        SET
          last_read_message_id = $3,
          last_read_at = $4
        WHERE conversation_id = $1
          AND user_id = $2
        RETURNING *
      `,
      [input.conversationId, input.userId, target.id, target.created_at],
    );
    if (!updated.rows[0]) {
      throw new NotFoundError(
        'CHAT_MEMBER_NOT_FOUND',
        'Conversation membership not found.',
      );
    }
    return { member: mapMember(updated.rows[0]), advanced: true };
  }

  async listReactions(messageId: string) {
    const result = await db.query<ReactionRow>(
      `
        SELECT *
        FROM chat.message_reactions
        WHERE message_id = $1
        ORDER BY created_at ASC
      `,
      [messageId],
    );
    return result.rows.map(mapReaction);
  }

  async listReactionsForMessages(messageIds: string[]) {
    const unique = Array.from(new Set(messageIds.filter(Boolean)));
    if (unique.length === 0) return [];
    const result = await db.query<ReactionRow>(
      `
        SELECT *
        FROM chat.message_reactions
        WHERE message_id = ANY($1::uuid[])
        ORDER BY created_at ASC
      `,
      [unique],
    );
    return result.rows.map(mapReaction);
  }

  async toggleReaction(input: {
    messageId: string;
    userId: string;
    emoji: string;
  }) {
    const emoji = input.emoji.trim();
    if (!emoji || emoji.length > 32) {
      throw new ValidationError('Invalid emoji.', { field: 'emoji' });
    }

    const existing = await db.query<ReactionRow>(
      `
        SELECT *
        FROM chat.message_reactions
        WHERE message_id = $1 AND user_id = $2 AND emoji = $3
        LIMIT 1
      `,
      [input.messageId, input.userId, emoji],
    );
    if (existing.rows[0]) {
      await db.query(
        `
          DELETE FROM chat.message_reactions
          WHERE id = $1
        `,
        [existing.rows[0].id],
      );
      return { added: false, reaction: null };
    }

    const inserted = await db.query<ReactionRow>(
      `
        INSERT INTO chat.message_reactions (message_id, user_id, emoji)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [input.messageId, input.userId, emoji],
    );
    return { added: true, reaction: mapReaction(inserted.rows[0]!) };
  }

  async leaveConversation(input: {
    conversationId: string;
    userId: string;
  }) {
    const result = await db.query(
      `
        DELETE FROM chat.conversation_members
        WHERE conversation_id = $1 AND user_id = $2
        RETURNING id
      `,
      [input.conversationId, input.userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateDisappearingSeconds(input: {
    organizationId: string;
    conversationId: string;
    seconds: number | null;
  }) {
    const allowed = new Set([3600, 86400, 604800, 2592000]);
    if (input.seconds != null && !allowed.has(input.seconds)) {
      throw new ValidationError('Invalid disappearing_seconds value.', {
        field: 'seconds',
      });
    }
    const result = await db.query<ConversationRow>(
      `
        UPDATE chat.conversations
        SET disappearing_seconds = $3, updated_at = NOW()
        WHERE id = $1 AND organization_id = $2
        RETURNING *
      `,
      [input.conversationId, input.organizationId, input.seconds],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'CHAT_CONVERSATION_NOT_FOUND',
        'Conversation not found.',
      );
    }
    return mapConversation(result.rows[0]);
  }

  async blockUser(input: {
    organizationId: string;
    blockerId: string;
    blockedId: string;
    conversationId?: string | null;
  }) {
    if (input.blockerId === input.blockedId) {
      throw new ValidationError('Cannot block yourself.', { field: 'blockedId' });
    }
    await db.query(
      `
        INSERT INTO chat.user_blocks (
          organization_id, blocker_id, blocked_id, conversation_id
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (blocker_id, blocked_id) DO UPDATE
          SET conversation_id = COALESCE(EXCLUDED.conversation_id, chat.user_blocks.conversation_id)
      `,
      [
        input.organizationId,
        input.blockerId,
        input.blockedId,
        input.conversationId ?? null,
      ],
    );
  }

  async unblockUser(input: {
    organizationId: string;
    blockerId: string;
    blockedId: string;
  }) {
    await db.query(
      `
        DELETE FROM chat.user_blocks
        WHERE organization_id = $1
          AND blocker_id = $2
          AND blocked_id = $3
      `,
      [input.organizationId, input.blockerId, input.blockedId],
    );
  }

  async listBlockedUserIds(input: {
    organizationId: string;
    blockerId: string;
  }) {
    const result = await db.query<{ blocked_id: string }>(
      `
        SELECT blocked_id
        FROM chat.user_blocks
        WHERE organization_id = $1 AND blocker_id = $2
      `,
      [input.organizationId, input.blockerId],
    );
    return result.rows.map((row) => row.blocked_id);
  }

  async isEitherBlocked(input: {
    organizationId: string;
    userA: string;
    userB: string;
  }) {
    const result = await db.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM chat.user_blocks
          WHERE organization_id = $1
            AND (
              (blocker_id = $2 AND blocked_id = $3)
              OR (blocker_id = $3 AND blocked_id = $2)
            )
        ) AS exists
      `,
      [input.organizationId, input.userA, input.userB],
    );
    return Boolean(result.rows[0]?.exists);
  }

  async upsertUserKeyMaterial(input: {
    organizationId: string;
    userId: string;
    keyFingerprint: string;
    publicWrapKey: string;
    keyVersion?: number;
  }) {
    const result = await db.query<{
      user_id: string;
      organization_id: string;
      key_fingerprint: string;
      public_wrap_key: string;
      key_version: number;
      updated_at: Date;
    }>(
      `
        INSERT INTO chat.user_key_material (
          user_id, organization_id, key_fingerprint, public_wrap_key, key_version
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, organization_id) DO UPDATE SET
          key_fingerprint = EXCLUDED.key_fingerprint,
          public_wrap_key = EXCLUDED.public_wrap_key,
          key_version = EXCLUDED.key_version,
          updated_at = NOW()
        RETURNING *
      `,
      [
        input.userId,
        input.organizationId,
        input.keyFingerprint,
        input.publicWrapKey,
        input.keyVersion ?? 1,
      ],
    );
    const row = result.rows[0]!;
    return {
      userId: row.user_id,
      organizationId: row.organization_id,
      keyFingerprint: row.key_fingerprint,
      publicWrapKey: row.public_wrap_key,
      keyVersion: row.key_version,
      updatedAt: row.updated_at,
    };
  }

  async getUserKeyMaterial(input: {
    organizationId: string;
    userId: string;
  }) {
    const result = await db.query<{
      user_id: string;
      organization_id: string;
      key_fingerprint: string;
      public_wrap_key: string;
      key_version: number;
      updated_at: Date;
    }>(
      `
        SELECT *
        FROM chat.user_key_material
        WHERE user_id = $1 AND organization_id = $2
        LIMIT 1
      `,
      [input.userId, input.organizationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      organizationId: row.organization_id,
      keyFingerprint: row.key_fingerprint,
      publicWrapKey: row.public_wrap_key,
      keyVersion: row.key_version,
      updatedAt: row.updated_at,
    };
  }

  async listPeerWrapKeys(input: {
    organizationId: string;
    conversationId: string;
    requesterUserId: string;
  }) {
    const member = await this.isMember(
      input.conversationId,
      input.requesterUserId,
      input.organizationId,
    );
    if (!member) {
      throw new ForbiddenError(
        'CHAT_NOT_A_MEMBER',
        'You are not a member of this conversation.',
      );
    }
    const result = await db.query<{
      user_id: string;
      public_wrap_key: string;
      key_version: number;
    }>(
      `
        SELECT k.user_id, k.public_wrap_key, k.key_version
        FROM chat.user_key_material k
        JOIN chat.conversation_members m
          ON m.user_id = k.user_id
         AND m.conversation_id = $2
        WHERE k.organization_id = $1
          AND k.user_id <> $3
      `,
      [input.organizationId, input.conversationId, input.requesterUserId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      publicWrapKey: row.public_wrap_key,
      keyVersion: row.key_version,
    }));
  }

  async upsertConversationKeyEnvelope(input: {
    organizationId: string;
    conversationId: string;
    actorUserId: string;
    targetUserId: string;
    wrappedKey: string;
    keyVersion?: number;
  }) {
    const actorMember = await this.isMember(
      input.conversationId,
      input.actorUserId,
      input.organizationId,
    );
    const targetMember = await this.isMember(
      input.conversationId,
      input.targetUserId,
      input.organizationId,
    );
    if (!actorMember || !targetMember) {
      throw new ForbiddenError(
        'CHAT_NOT_A_MEMBER',
        'Both users must be members of the conversation.',
      );
    }

    const conversation = await this.getConversation(
      input.organizationId,
      input.conversationId,
    );
    if (!conversation) {
      throw new NotFoundError(
        'CHAT_CONVERSATION_NOT_FOUND',
        'Conversation not found.',
      );
    }

    const result = await db.query<{
      id: string;
      organization_id: string;
      conversation_id: string;
      user_id: string;
      wrapped_key: string;
      key_version: number;
      updated_at: Date;
    }>(
      `
        INSERT INTO chat.conversation_key_envelopes (
          organization_id, conversation_id, user_id, wrapped_key, key_version
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (conversation_id, user_id, key_version) DO UPDATE SET
          wrapped_key = EXCLUDED.wrapped_key,
          updated_at = NOW()
        RETURNING *
      `,
      [
        input.organizationId,
        input.conversationId,
        input.targetUserId,
        input.wrappedKey,
        input.keyVersion ?? 1,
      ],
    );
    const row = result.rows[0]!;
    return {
      id: row.id,
      organizationId: row.organization_id,
      conversationId: row.conversation_id,
      userId: row.user_id,
      wrappedKey: row.wrapped_key,
      keyVersion: row.key_version,
      updatedAt: row.updated_at,
    };
  }

  async getOwnConversationKeyEnvelope(input: {
    organizationId: string;
    conversationId: string;
    userId: string;
    keyVersion?: number;
  }) {
    const result = await db.query<{
      id: string;
      organization_id: string;
      conversation_id: string;
      user_id: string;
      wrapped_key: string;
      key_version: number;
      updated_at: Date;
    }>(
      `
        SELECT *
        FROM chat.conversation_key_envelopes
        WHERE organization_id = $1
          AND conversation_id = $2
          AND user_id = $3
          AND key_version = $4
        LIMIT 1
      `,
      [
        input.organizationId,
        input.conversationId,
        input.userId,
        input.keyVersion ?? 1,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      conversationId: row.conversation_id,
      userId: row.user_id,
      wrappedKey: row.wrapped_key,
      keyVersion: row.key_version,
      updatedAt: row.updated_at,
    };
  }
}
