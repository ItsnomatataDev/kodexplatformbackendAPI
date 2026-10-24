import { logger } from '../config/logger.js';
import type { ChatStore } from '../chat/store.js';
import type { WorkStore } from '../work/store.js';
import {
  NOTIFICATION_TYPES,
  type NotificationStore,
} from './store.js';

function uniqueIds(userIds: Array<string | null | undefined>, excludeUserId: string) {
  return [...new Set(userIds.filter((id): id is string => Boolean(id)))].filter(
    (id) => id !== excludeUserId,
  );
}

function actorLabel(
  displayName: string | null | undefined,
  email: string | null | undefined,
) {
  const name = displayName?.trim();
  if (name) {
    return name;
  }
  const local = email?.split('@')[0]?.trim();
  return local && local.length > 0 ? local : 'Someone';
}

function taskActionUrl(cardId: string, boardId: string) {
  return `/boards/${boardId}?cardId=${cardId}`;
}

async function createQuietly(
  notifications: NotificationStore,
  input: Parameters<NotificationStore['create']>[0],
) {
  try {
    await notifications.create(input);
  } catch (error) {
    logger.warn({ err: error, type: input.type }, 'Failed to create notification');
  }
}

export async function notifyCardAssigned(params: {
  notifications: NotificationStore;
  work: WorkStore;
  organizationId: string;
  cardId: string;
  recipientUserId: string;
  actorUserId: string;
  actorEmail?: string | null;
}) {
  if (params.recipientUserId === params.actorUserId) {
    return;
  }

  const card = await params.work.getCardById(params.organizationId, params.cardId);
  if (!card) {
    return;
  }

  const actorName = actorLabel(
    await params.notifications.getDisplayName(params.actorUserId),
    params.actorEmail,
  );

  await createQuietly(params.notifications, {
    organizationId: params.organizationId,
    recipientUserId: params.recipientUserId,
    actorUserId: params.actorUserId,
    type: NOTIFICATION_TYPES.taskAssigned,
    title: 'New task assigned',
    message: `${actorName} assigned you to "${card.title}".`,
    entityType: 'task',
    entityId: card.id,
    actionUrl: taskActionUrl(card.id, card.boardId),
    priority: 'high',
    category: 'tasks',
    dedupeKey: `task_assigned:${card.id}:${params.recipientUserId}`,
    metadata: {
      taskId: card.id,
      taskTitle: card.title,
      boardId: card.boardId,
      actorUserId: params.actorUserId,
      actorName,
    },
  });
}

export async function notifyCardCommented(params: {
  notifications: NotificationStore;
  work: WorkStore;
  organizationId: string;
  cardId: string;
  commentId: string;
  actorUserId: string;
  actorEmail?: string | null;
}) {
  const card = await params.work.getCardById(params.organizationId, params.cardId);
  if (!card) {
    return;
  }

  const [assignees, watchers] = await Promise.all([
    params.work.listAssignees(params.organizationId, params.cardId),
    params.work.listWatchers(params.organizationId, params.cardId),
  ]);

  const recipients = uniqueIds(
    [
      card.createdBy,
      card.assignedTo,
      ...assignees.map((assignee) => assignee.userId),
      ...watchers.map((watcher) => watcher.userId),
    ],
    params.actorUserId,
  );

  if (recipients.length === 0) {
    return;
  }

  const actorName = actorLabel(
    await params.notifications.getDisplayName(params.actorUserId),
    params.actorEmail,
  );

  await Promise.all(
    recipients.map((recipientUserId) =>
      createQuietly(params.notifications, {
        organizationId: params.organizationId,
        recipientUserId,
        actorUserId: params.actorUserId,
        type: NOTIFICATION_TYPES.taskComment,
        title: 'New task comment',
        message: `${actorName} commented on "${card.title}".`,
        entityType: 'task',
        entityId: card.id,
        actionUrl: taskActionUrl(card.id, card.boardId),
        priority: 'medium',
        category: 'tasks',
        dedupeKey: `task_comment:${params.commentId}:${recipientUserId}`,
        metadata: {
          taskId: card.id,
          taskTitle: card.title,
          boardId: card.boardId,
          commentId: params.commentId,
          actorUserId: params.actorUserId,
          actorName,
        },
      }),
    ),
  );
}

function chatPreview(params: {
  body?: string | null;
  messageType?: string | null;
  attachmentName?: string | null;
}) {
  const body = params.body?.trim();
  if (body) return body.slice(0, 140);
  const type = (params.messageType ?? 'text').toLowerCase();
  if (type === 'audio') return 'Voice note';
  if (type === 'image') return 'Photo';
  if (type === 'file') return params.attachmentName?.trim() || 'Attachment';
  return 'New message';
}

/** In-app chat notifications for conversation members (except sender / muted). */
export async function notifyChatMessage(params: {
  notifications: NotificationStore;
  chat: ChatStore;
  organizationId: string;
  conversationId: string;
  messageId: string;
  actorUserId: string;
  actorEmail?: string | null;
  body?: string | null;
  messageType?: string | null;
  attachmentName?: string | null;
  conversationTitle?: string | null;
  conversationType?: string | null;
}) {
  const members = await params.chat.listMembers(params.conversationId);
  const recipients = members.filter(
    (member) =>
      member.userId !== params.actorUserId && member.isMuted !== true,
  );
  if (recipients.length === 0) return;

  const actorName = actorLabel(
    await params.notifications.getDisplayName(params.actorUserId),
    params.actorEmail,
  );
  const preview = chatPreview({
    body: params.body,
    messageType: params.messageType,
    attachmentName: params.attachmentName,
  });
  const isDirect = (params.conversationType ?? 'direct') === 'direct';
  const title = isDirect
    ? `${actorName} sent you a message`
    : `${actorName} in ${params.conversationTitle?.trim() || 'Group chat'}`;

  await Promise.all(
    recipients.map((member) =>
      createQuietly(params.notifications, {
        organizationId: params.organizationId,
        recipientUserId: member.userId,
        actorUserId: params.actorUserId,
        type: NOTIFICATION_TYPES.chatMessage,
        title,
        message: preview,
        entityType: 'chat',
        entityId: params.conversationId,
        actionUrl: `/chat?conversationId=${params.conversationId}&messageId=${params.messageId}`,
        priority: 'medium',
        category: 'chat',
        dedupeKey: `chat_message:${params.messageId}:${member.userId}`,
        metadata: {
          conversationId: params.conversationId,
          conversationType: params.conversationType ?? 'direct',
          conversationTitle: params.conversationTitle ?? null,
          senderId: params.actorUserId,
          senderName: actorName,
          messageId: params.messageId,
          messageType: params.messageType ?? 'text',
          category: 'chat',
        },
      }),
    ),
  );
}
