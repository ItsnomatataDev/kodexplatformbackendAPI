import { Hono } from "hono";
import { getAuth } from "../auth/middleware.js";
import { rejectClientUserOverride } from "../auth/account.js";
import { assertAuthorized } from "../authorization/authorize.js";
import { requireOrganizationId } from "../authorization/organization.js";
import { isUuid } from "../auth/uuid.js";
import { NotFoundError, ValidationError } from "../http/errors.js";
import { rateLimitWork } from "../http/work-rate-limit.js";
import {
  readJson,
  readOptionalBoolean,
  rejectIdentityOverrides,
  requireId,
} from "../work/http.js";
import type {
  NotificationRecord,
  NotificationStore,
} from "../notifications/store.js";

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
    c.req.query("userId") ??
      (typeof body.userId === "string" ? body.userId : null) ??
      (typeof body.recipientUserId === "string"
        ? body.recipientUserId
        : null) ??
      (typeof body.recipient_user_id === "string"
        ? body.recipient_user_id
        : null),
  );
}

function authorizeInbox(auth: ReturnType<typeof getAuth>, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: {
      type: "notification",
      organizationId,
    },
  });
  return organizationId;
}

export function createNotificationRoutes(
  dependencies: NotificationRouteDependencies,
) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const auth = getAuth(c);
    rejectRecipientOverride(auth, c);
    const organizationId = authorizeInbox(auth, "notifications.read");
    const unreadOnlyRaw =
      c.req.query("unreadOnly") ?? c.req.query("unread_only");
    const unreadOnly =
      unreadOnlyRaw === undefined
        ? false
        : unreadOnlyRaw === "true" || unreadOnlyRaw === "1";
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10);
    if (Number.isNaN(limit) || limit < 1) {
      throw new ValidationError("limit must be a positive integer.", {
        field: "limit",
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

  routes.get("/unread-count", async (c) => {
    const auth = getAuth(c);
    rejectRecipientOverride(auth, c);
    const organizationId = authorizeInbox(auth, "notifications.read");
    const unreadCount = await dependencies.store.countUnread(
      organizationId,
      auth.actor.userId,
    );
    return c.json({ unreadCount });
  });

  routes.post("/read-all", async (c) => {
    const auth = getAuth(c);
    rejectRecipientOverride(auth, c);
    const organizationId = authorizeInbox(auth, "notifications.update");
    await rateLimitWork(c, "mutation");
    const updated = await dependencies.store.markAllRead(
      organizationId,
      auth.actor.userId,
    );
    return c.json({ updated });
  });

  routes.patch("/:notificationId", async (c) => {
    const auth = getAuth(c);
    rejectRecipientOverride(auth, c);
    const organizationId = authorizeInbox(auth, "notifications.update");
    await rateLimitWork(c, "mutation");
    const notificationId = requireId(
      c.req.param("notificationId"),
      "notificationId",
    );
    const body = await readJson(c);
    rejectRecipientOverride(auth, c, body);
    const isRead = readOptionalBoolean(body.isRead ?? body.is_read, "isRead");
    if (isRead !== true) {
      throw new ValidationError("isRead must be true.", { field: "isRead" });
    }
    const notification = await dependencies.store.markRead(
      organizationId,
      auth.actor.userId,
      notificationId,
    );
    if (!notification) {
      throw new NotFoundError(
        "NOTIFICATION_NOT_FOUND",
        "The notification was not found.",
      );
    }
    return c.json({ notification: serializeNotification(notification) });
  });

  routes.post("/", async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeInbox(auth, "notifications.create");
    await rateLimitWork(c, "mutation");
    const body = await readJson(c);
    const userIdsRaw = body.userIds ?? body.user_ids ?? body.recipientUserIds;
    const userIds = Array.isArray(userIdsRaw)
      ? userIdsRaw.filter((id): id is string => typeof id === "string" && Boolean(id))
      : typeof body.userId === "string"
        ? [body.userId]
        : typeof body.recipientUserId === "string"
          ? [body.recipientUserId]
          : [];
    if (userIds.length === 0) {
      throw new ValidationError("At least one recipient userId is required.", {
        field: "userIds",
      });
    }
    const type =
      typeof body.type === "string" && body.type.trim()
        ? body.type.trim()
        : null;
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : null;
    if (!type || !title) {
      throw new ValidationError("type and title are required.");
    }

    const created = [];
    const uniqueRecipients = [...new Set(userIds)];
    const entityType =
      typeof body.entityType === "string"
        ? body.entityType
        : typeof body.entity_type === "string"
          ? body.entity_type
          : "system";
    const entityIdRaw =
      typeof body.entityId === "string"
        ? body.entityId
        : typeof body.entity_id === "string"
          ? body.entity_id
          : null;
    const entityId =
      entityIdRaw && isUuid(entityIdRaw) ? entityIdRaw : crypto.randomUUID();
    const actionUrl =
      typeof body.actionUrl === "string"
        ? body.actionUrl
        : typeof body.action_url === "string"
          ? body.action_url
          : null;
    const message = typeof body.message === "string" ? body.message : null;
    const priority =
      typeof body.priority === "string" ? body.priority : "medium";
    const category =
      typeof body.category === "string" ? body.category : null;
    const dedupeKey =
      typeof body.dedupeKey === "string"
        ? body.dedupeKey
        : typeof body.dedupe_key === "string"
          ? body.dedupe_key
          : null;
    const metadata =
      body.metadata && typeof body.metadata === "object"
        ? (body.metadata as Record<string, unknown>)
        : {};
    const sendEmail =
      body.sendEmail === true ||
      body.send_email === true ||
      (Array.isArray(body.channels) &&
        body.channels.includes("email") &&
        body.sendEmail !== false &&
        body.send_email !== false);

    for (const recipientUserId of uniqueRecipients) {
      if (!isUuid(recipientUserId)) {
        throw new ValidationError("Each userId must be a UUID.", {
          field: "userIds",
        });
      }
      const result = await dependencies.store.create({
        organizationId,
        recipientUserId,
        actorUserId: auth.actor.userId,
        type,
        title,
        message,
        entityType,
        entityId,
        actionUrl,
        priority,
        category,
        dedupeKey: dedupeKey
          ? uniqueRecipients.length > 1
            ? `${dedupeKey}:${recipientUserId}`
            : dedupeKey
          : null,
        metadata,
      });
      if (result !== "duplicate") created.push(serializeNotification(result));
    }

    let emailsSent = 0;
    if (sendEmail) {
      const contacts = await dependencies.store.getRecipientEmails(
        uniqueRecipients,
      );
      const { sendAttendanceEmail } = await import(
        "../email/attendance-mailer.js"
      );
      for (const recipientUserId of uniqueRecipients) {
        const contact = contacts.get(recipientUserId);
        if (!contact?.email) continue;
        const sent = await sendAttendanceEmail({
          to: contact.email,
          subject: title,
          text: [title, message].filter(Boolean).join("\n\n"),
        });
        if (sent) emailsSent += 1;
      }
    }

    return c.json(
      { ok: true, notifications: created, emailsSent },
      201,
    );
  });

  routes.post("/email", async (c) => {
    const auth = getAuth(c);
    authorizeInbox(auth, "notifications.create");
    await rateLimitWork(c, "mutation");
    const body = await readJson(c);
    const to =
      typeof body.to === "string"
        ? body.to
        : typeof body.email === "string"
          ? body.email
          : null;
    const subject =
      typeof body.subject === "string" ? body.subject : null;
    const text =
      typeof body.text === "string"
        ? body.text
        : typeof body.message === "string"
          ? body.message
          : null;
    const html = typeof body.html === "string" ? body.html : undefined;
    if (!to || !subject || (!text && !html)) {
      throw new ValidationError("to, subject, and text (or html) are required.");
    }
    const { sendAttendanceEmail } = await import(
      "../email/attendance-mailer.js"
    );
    const sent = await sendAttendanceEmail({
      to,
      subject,
      text: text ?? subject,
      htmlBody: html,
    });
    return c.json({ ok: sent });
  });

  return routes;
}
