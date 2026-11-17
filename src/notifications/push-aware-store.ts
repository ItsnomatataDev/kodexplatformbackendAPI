import { sendExpoPushForNotification } from './expo-push.js';
import type { PostgresPushSubscriptionStore } from './push-store.js';
import type {
  CreateNotificationInput,
  ListNotificationsInput,
  NotificationRecord,
  NotificationStore,
} from './store.js';

/**
 * Decorates NotificationStore.create so Expo push is attempted after persist.
 * Failures are logged and never fail the in-app notification write.
 */
export class PushAwareNotificationStore implements NotificationStore {
  constructor(
    private readonly inner: NotificationStore,
    private readonly pushStore: PostgresPushSubscriptionStore,
  ) {}

  list(input: ListNotificationsInput) {
    return this.inner.list(input);
  }

  countUnread(organizationId: string, recipientUserId: string) {
    return this.inner.countUnread(organizationId, recipientUserId);
  }

  getById(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ) {
    return this.inner.getById(organizationId, recipientUserId, notificationId);
  }

  async create(input: CreateNotificationInput) {
    const result = await this.inner.create(input);
    if (result !== 'duplicate') {
      void sendExpoPushForNotification({
        notification: result,
        pushStore: this.pushStore,
      }).catch((error) => {
        console.warn('[push] send after notification create failed:', error);
      });
    }
    return result;
  }

  markRead(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ) {
    return this.inner.markRead(organizationId, recipientUserId, notificationId);
  }

  markAllRead(organizationId: string, recipientUserId: string) {
    return this.inner.markAllRead(organizationId, recipientUserId);
  }

  getDisplayName(userId: string) {
    return this.inner.getDisplayName(userId);
  }

  getRecipientEmails(userIds: string[], organizationId?: string) {
    return this.inner.getRecipientEmails(userIds, organizationId);
  }

  assertActiveOrgRecipients(organizationId: string, userIds: string[]) {
    return this.inner.assertActiveOrgRecipients(organizationId, userIds);
  }

  findActiveMemberByEmail(organizationId: string, email: string) {
    return this.inner.findActiveMemberByEmail(organizationId, email);
  }
}

export type { NotificationRecord };
