export const NOTIFICATION_TYPES = {
  taskAssigned: 'task_assigned',
  taskComment: 'task_comment',
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export type NotificationRecord = {
  id: string;
  organizationId: string;
  recipientUserId: string;
  actorUserId: string | null;
  type: NotificationType;
  title: string;
  message: string | null;
  entityType: string;
  entityId: string;
  actionUrl: string | null;
  priority: string;
  category: string | null;
  dedupeKey: string | null;
  metadata: Record<string, unknown>;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
};

export type CreateNotificationInput = {
  organizationId: string;
  recipientUserId: string;
  actorUserId?: string | null;
  type: NotificationType;
  title: string;
  message?: string | null;
  entityType: string;
  entityId: string;
  actionUrl?: string | null;
  priority?: string;
  category?: string | null;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown>;
};

export type ListNotificationsInput = {
  organizationId: string;
  recipientUserId: string;
  unreadOnly?: boolean;
  limit?: number;
};

export interface NotificationStore {
  list(input: ListNotificationsInput): Promise<NotificationRecord[]>;
  countUnread(organizationId: string, recipientUserId: string): Promise<number>;
  getById(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ): Promise<NotificationRecord | null>;
  create(
    input: CreateNotificationInput,
  ): Promise<NotificationRecord | 'duplicate'>;
  markRead(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ): Promise<NotificationRecord | null>;
  markAllRead(
    organizationId: string,
    recipientUserId: string,
  ): Promise<number>;
  getDisplayName(userId: string): Promise<string | null>;
}
