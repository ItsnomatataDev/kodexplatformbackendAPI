import { randomUUID } from 'node:crypto';
import type {
  CreateNotificationInput,
  ListNotificationsInput,
  NotificationRecord,
  NotificationStore,
} from './store.js';

export class MemoryNotificationStore implements NotificationStore {
  private readonly notifications = new Map<string, NotificationRecord>();
  private readonly displayNames = new Map<string, string>();

  seedDisplayName(userId: string, name: string) {
    this.displayNames.set(userId, name);
  }

  async list(input: ListNotificationsInput) {
    const limit = input.limit ?? 50;
    return [...this.notifications.values()]
      .filter((notification) => {
        if (notification.organizationId !== input.organizationId) {
          return false;
        }
        if (notification.recipientUserId !== input.recipientUserId) {
          return false;
        }
        if (input.unreadOnly && notification.isRead) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map((notification) => ({
        ...notification,
        metadata: { ...notification.metadata },
      }));
  }

  async countUnread(organizationId: string, recipientUserId: string) {
    return [...this.notifications.values()].filter(
      (notification) =>
        notification.organizationId === organizationId &&
        notification.recipientUserId === recipientUserId &&
        !notification.isRead,
    ).length;
  }

  async getById(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ) {
    const notification = this.notifications.get(notificationId);
    if (
      !notification ||
      notification.organizationId !== organizationId ||
      notification.recipientUserId !== recipientUserId
    ) {
      return null;
    }
    return {
      ...notification,
      metadata: { ...notification.metadata },
    };
  }

  async create(input: CreateNotificationInput) {
    if (input.dedupeKey) {
      const duplicate = [...this.notifications.values()].find(
        (notification) =>
          notification.organizationId === input.organizationId &&
          notification.dedupeKey === input.dedupeKey,
      );
      if (duplicate) {
        return 'duplicate';
      }
    }

    const now = new Date();
    const notification: NotificationRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      recipientUserId: input.recipientUserId,
      actorUserId: input.actorUserId ?? null,
      type: input.type,
      title: input.title,
      message: input.message ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      actionUrl: input.actionUrl ?? null,
      priority: input.priority ?? 'medium',
      category: input.category ?? null,
      dedupeKey: input.dedupeKey ?? null,
      metadata: input.metadata ? { ...input.metadata } : {},
      isRead: false,
      readAt: null,
      createdAt: now,
    };
    this.notifications.set(notification.id, notification);
    return {
      ...notification,
      metadata: { ...notification.metadata },
    };
  }

  async markRead(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ) {
    const notification = this.notifications.get(notificationId);
    if (
      !notification ||
      notification.organizationId !== organizationId ||
      notification.recipientUserId !== recipientUserId
    ) {
      return null;
    }
    if (!notification.isRead) {
      notification.isRead = true;
      notification.readAt = new Date();
    }
    return {
      ...notification,
      metadata: { ...notification.metadata },
    };
  }

  async markAllRead(organizationId: string, recipientUserId: string) {
    let updated = 0;
    const readAt = new Date();
    for (const notification of this.notifications.values()) {
      if (
        notification.organizationId === organizationId &&
        notification.recipientUserId === recipientUserId &&
        !notification.isRead
      ) {
        notification.isRead = true;
        notification.readAt = readAt;
        updated += 1;
      }
    }
    return updated;
  }

  async getDisplayName(userId: string) {
    return this.displayNames.get(userId) ?? null;
  }

  async getRecipientEmails(userIds: string[]) {
    const map = new Map<string, { email: string; fullName: string | null }>();
    for (const userId of userIds) {
      const name = this.displayNames.get(userId);
      if (name) {
        map.set(userId, {
          email: `${userId}@example.test`,
          fullName: name,
        });
      }
    }
    return map;
  }
}
