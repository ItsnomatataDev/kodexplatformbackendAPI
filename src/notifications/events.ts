import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { ChatStore } from '../chat/store.js';
import type { SimpleEmail } from '../email/attendance-mailer.js';
import { APP_URL } from '../email/branded-templates.js';
import type { TicketCommentRecord, TicketRecord } from '../tickets/store.js';
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

function appOrigin() {
  return (env.appPublicUrl || APP_URL).replace(/\/+$/, '');
}

function previewComment(body: string) {
  const trimmed = body.trim();
  if (trimmed.length <= 280) {
    return trimmed;
  }
  return `${trimmed.slice(0, 277)}...`;
}

export type TicketRequesterNotifyEvent =
  | { kind: 'technician_reply'; body: string; commentId: string }
  | { kind: 'assigned'; technicianName?: string | null }
  | { kind: 'waiting_for_requester' }
  | { kind: 'resolved' };

export async function notifyTicketRequester(params: {
  notifications: NotificationStore;
  sendEmail: (message: SimpleEmail) => Promise<boolean>;
  ticket: TicketRecord;
  actorUserId: string;
  actorEmail?: string | null;
  event: TicketRequesterNotifyEvent;
}) {
  if (params.ticket.userId && params.ticket.userId === params.actorUserId) {
    return;
  }

  const actorName = actorLabel(
    await params.notifications.getDisplayName(params.actorUserId),
    params.actorEmail,
  );
  const origin = appOrigin();
  const trackingUrl = `${origin}/support/track/${params.ticket.trackingToken}`;
  const inboxUrl = `${origin}/my-support`;
  const actionUrl =
    params.ticket.requesterType === 'external' ? trackingUrl : inboxUrl;
  const actionLabel =
    params.ticket.requesterType === 'external' ? 'View ticket' : 'Open My Support';
  const copy = requesterEventCopy(params.ticket, params.event, actorName);

  if (params.ticket.userId) {
    await createQuietly(params.notifications, {
      organizationId: params.ticket.organizationId,
      recipientUserId: params.ticket.userId,
      actorUserId: params.actorUserId,
      type: copy.type,
      title: copy.title,
      message: copy.message,
      entityType: 'ticket',
      entityId: params.ticket.id,
      actionUrl: '/my-support',
      priority: 'high',
      category: 'tickets',
      dedupeKey: `${copy.dedupeKey}:${params.ticket.userId}`,
      metadata: {
        ticketId: params.ticket.id,
        ticketNumber: params.ticket.ticketNumber,
        event: params.event.kind,
        actorUserId: params.actorUserId,
        actorName,
      },
    });
  }

  let to = params.ticket.requesterEmail?.trim().toLowerCase() ?? '';
  if (!to && params.ticket.userId) {
    const emails = await params.notifications.getRecipientEmails(
      [params.ticket.userId],
      params.ticket.organizationId,
    );
    to = emails.get(params.ticket.userId)?.email?.trim().toLowerCase() ?? '';
  }
  const actorEmail = params.actorEmail?.trim().toLowerCase() ?? '';
  if (!to || to === actorEmail) {
    return;
  }

  try {
    await params.sendEmail({
      to,
      subject: copy.subject,
      firstName: params.ticket.requesterName ?? params.ticket.externalName ?? undefined,
      actionUrl,
      actionLabel,
      text: `${copy.text}\n\nView the ticket: ${actionUrl}`,
    });
  } catch (error) {
    logger.warn(
      { err: error, ticketId: params.ticket.id, event: params.event.kind },
      'Failed to email ticket requester',
    );
  }
}

function requesterEventCopy(
  ticket: TicketRecord,
  event: TicketRequesterNotifyEvent,
  actorName: string,
) {
  const number = ticket.ticketNumber;
  const subject = ticket.subject;
  if (event.kind === 'technician_reply') {
    const preview = previewComment(event.body);
    return {
      type: NOTIFICATION_TYPES.ticketComment,
      title: `Update on ${number}`,
      message: `${actorName} replied: ${preview}`,
      subject: `Response on ticket ${number}`,
      text: [
        `A technician replied to your support ticket ${number} (${subject}).`,
        '',
        preview,
      ].join('\n'),
      dedupeKey: `ticket_comment:${event.commentId}`,
    };
  }
  if (event.kind === 'assigned') {
    const technician = event.technicianName?.trim() || 'a technician';
    return {
      type: NOTIFICATION_TYPES.ticketAssigned,
      title: `${number} assigned`,
      message: `Your ticket was assigned to ${technician}.`,
      subject: `Ticket ${number} assigned to a technician`,
      text: `Your support ticket ${number} (${subject}) has been assigned to ${technician}. They will follow up with you.`,
      dedupeKey: `ticket_assigned:${ticket.id}:${ticket.assignedTo ?? 'open'}`,
    };
  }
  if (event.kind === 'waiting_for_requester') {
    return {
      type: NOTIFICATION_TYPES.ticketWaiting,
      title: `Action needed on ${number}`,
      message: 'IT is waiting for you to reply or close this ticket.',
      subject: `Action needed on ticket ${number}`,
      text: `IT marked your support ticket ${number} (${subject}) as waiting for you. Please reply with any extra information, or close the ticket if the issue is resolved.`,
      dedupeKey: `ticket_waiting:${ticket.id}:${ticket.updatedAt.toISOString()}`,
    };
  }
  return {
    type: NOTIFICATION_TYPES.ticketResolved,
    title: `${number} resolved`,
    message: 'Your ticket was marked resolved.',
    subject: `Ticket ${number} resolved`,
    text: `Your support ticket ${number} (${subject}) has been marked resolved.`,
    dedupeKey: `ticket_resolved:${ticket.id}`,
  };
}

export async function notifyTicketPublicComment(params: {
  notifications: NotificationStore;
  sendEmail: (message: SimpleEmail) => Promise<boolean>;
  ticket: TicketRecord;
  comment: TicketCommentRecord;
  actorUserId: string;
  actorEmail?: string | null;
}) {
  if (params.comment.visibility !== 'public') {
    return;
  }
  if (params.comment.authorType === 'external') {
    return;
  }
  await notifyTicketRequester({
    notifications: params.notifications,
    sendEmail: params.sendEmail,
    ticket: params.ticket,
    actorUserId: params.actorUserId,
    actorEmail: params.actorEmail,
    event: {
      kind: 'technician_reply',
      body: params.comment.body,
      commentId: params.comment.id,
    },
  });
}
