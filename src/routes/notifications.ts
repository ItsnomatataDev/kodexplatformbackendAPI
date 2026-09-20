import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { rejectClientUserOverride } from '../auth/account.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { rateLimitWork } from '../http/work-rate-limit.js';
import {
  readJson,
  readOptionalBoolean,
  rejectIdentityOverrides,
  requireId,
} from '../work/http.js';
import type { NotificationRecord, NotificationStore } from '../notifications/store.js';

export type NotificationRouteDependencies = {
  store: NotificationStore;
};

function serializeNotification(notification: NotificationRecord) {
  return {
    id: notification.id,
    organizationId: notification.organizationId,
    userId: notification.recipientUserId,
    actorUserId: notification.actorUserId,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    entityType: notification.entityType,
    entityId: notification.entityId,
    actionUrl: notification.actionUrl,
    priority: notification.priority,
    category: notification.category,
    dedupeKey: notification.dedupeKey,
    metadata: notification.metadata,
    isRead: notification.isRead,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

function rejectRecipientOverride(
  auth: ReturnType<typeof getAuth>,
  c: {
    req: {
      query: (name: string) => string | undefined;
      header: (name: string) => string | undefined;
    };
  },
  body: Record<string, unknown> = {},
) {
  rejectIdentityOverrides(auth, c, body);
  rejectClientUserOverride(
    auth,
    c.req.query('userId') ??
      (typeof body.userId === 'string' ? body.userId : null) ??
      (typeof body.recipientUserId === 'string' ? body.recipientUserId : null) ??
      (typeof body.recipient_user_id === 'string' ? body.recipient_user_id : null),
  );
}

function authorizeInbox(auth: ReturnType<typeof getAuth>, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: {
      type: 'notification',
      organizationId,
    },
  });
  return organizationId;
}

export function createNotificationRoutes(
  dependencies: NotificationRouteDependencies,
) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    const auth = getAuth(c);
    rejectRecipientOverride(auth, c);
    const organizationId = authorizeInbox(auth, 'notifications.read');
    const unreadOnlyRaw = c.req.query('unreadOnly') ?? c.req.query('unread_only');
    const unreadOnly =
      unreadOnlyRaw === undefined
        ? false
        : unreadOnlyRaw === 'true' || unreadOnlyRaw === '1';
    const limitRaw = c.req.query('limit');
    const limit =
      limitRaw === undefined
        ? 50
        : Number.parseInt(limitRaw, 10);
    if (Number.isNaN(limit) || limit < 1) {
      throw new ValidationError('limit must be a positive integer.', {
        field: 'limit',
      });
    }

    const [notifications, unreadCount] = await Promise.all([
      dependencies.store.list({
        organizationId,
        recipientUserId: auth.actor.userId,
        unreadOnly,
        limit,
      }),
      dependencies.store.countUnread(organizationId, auth.actor.userId),
    ]);

    return c.json({
      notifications: notifications.map(serializeNotification),
      unreadCount,
    });
  });

  routes.get('/unread-count', async (c) => {
    const auth = getAuth(c);
    rejectRecipientOverride(auth, c);
    const organizationId = authorizeInbox(auth, 'notifications.read');
    const unreadCount = await dependencies.store.countUnread(
      organizationId,
      auth.actor.userId,
    );
    return c.json({ unreadCount });
  });

  routes.post('/read-all', async (c) => {
    const auth = getAuth(c);
    rejectRecipientOverride(auth, c);
    const organizationId = authorizeInbox(auth, 'notifications.update');
    await rateLimitWork(c, 'mutation');
    const updated = await dependencies.store.markAllRead(
      organizationId,
      auth.actor.userId,
    );
    return c.json({ updated });
  });

  routes.patch('/:notificationId', async (c) => {
    const auth = getAuth(c);
    rejectRecipientOverride(auth, c);
    const organizationId = authorizeInbox(auth, 'notifications.update');
    await rateLimitWork(c, 'mutation');
    const notificationId = requireId(c.req.param('notificationId'), 'notificationId');
    const body = await readJson(c);
    rejectRecipientOverride(auth, c, body);
    const isRead = readOptionalBoolean(body.isRead ?? body.is_read, 'isRead');
    if (isRead !== true) {
      throw new ValidationError('isRead must be true.', { field: 'isRead' });
    }
    const notification = await dependencies.store.markRead(
      organizationId,
      auth.actor.userId,
      notificationId,
    );
    if (!notification) {
      throw new NotFoundError(
        'NOTIFICATION_NOT_FOUND',
        'The notification was not found.',
      );
    }
    return c.json({ notification: serializeNotification(notification) });
  });

  return routes;
}
