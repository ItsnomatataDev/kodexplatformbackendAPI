import { db } from '../db/pool.js';
import type {
  CreateNotificationInput,
  ListNotificationsInput,
  NotificationRecord,
  NotificationStore,
  NotificationType,
} from './store.js';

type NotificationRow = {
  id: string;
  organization_id: string;
  recipient_user_id: string;
  actor_user_id: string | null;
  type: NotificationType;
  title: string;
  message: string | null;
  entity_type: string;
  entity_id: string;
  action_url: string | null;
  priority: string;
  category: string | null;
  dedupe_key: string | null;
  metadata: Record<string, unknown> | null;
  is_read: boolean;
  read_at: Date | null;
  created_at: Date;
};

const NOTIFICATION_COLUMNS = `
  id,
  organization_id,
  recipient_user_id,
  actor_user_id,
  type,
  title,
  message,
  entity_type,
  entity_id,
  action_url,
  priority,
  category,
  dedupe_key,
  metadata,
  is_read,
  read_at,
  created_at
`;

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === '23505',
  );
}

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    recipientUserId: row.recipient_user_id,
    actorUserId: row.actor_user_id,
    type: row.type,
    title: row.title,
    message: row.message,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actionUrl: row.action_url,
    priority: row.priority,
    category: row.category,
    dedupeKey: row.dedupe_key,
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
    isRead: row.is_read,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export class PostgresNotificationStore implements NotificationStore {
  async list(input: ListNotificationsInput) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const result = await db.query<NotificationRow>(
      `
        SELECT ${NOTIFICATION_COLUMNS}
        FROM notifications.notifications
        WHERE organization_id = $1
          AND recipient_user_id = $2
          AND ($3::boolean IS NOT TRUE OR is_read = FALSE)
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `,
      [input.organizationId, input.recipientUserId, input.unreadOnly ?? false, limit],
    );
    return result.rows.map(mapNotification);
  }

  async countUnread(organizationId: string, recipientUserId: string) {
    const result = await db.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM notifications.notifications
        WHERE organization_id = $1
          AND recipient_user_id = $2
          AND is_read = FALSE
      `,
      [organizationId, recipientUserId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getById(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ) {
    const result = await db.query<NotificationRow>(
      `
        SELECT ${NOTIFICATION_COLUMNS}
        FROM notifications.notifications
        WHERE id = $1
          AND organization_id = $2
          AND recipient_user_id = $3
      `,
      [notificationId, organizationId, recipientUserId],
    );
    return result.rows[0] ? mapNotification(result.rows[0]) : null;
  }

  async create(input: CreateNotificationInput) {
    try {
      const result = await db.query<NotificationRow>(
        `
          INSERT INTO notifications.notifications (
            organization_id,
            recipient_user_id,
            actor_user_id,
            type,
            title,
            message,
            entity_type,
            entity_id,
            action_url,
            priority,
            category,
            dedupe_key,
            metadata
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
          )
          ON CONFLICT (organization_id, dedupe_key)
            WHERE dedupe_key IS NOT NULL
            DO NOTHING
          RETURNING ${NOTIFICATION_COLUMNS}
        `,
        [
          input.organizationId,
          input.recipientUserId,
          input.actorUserId ?? null,
          input.type,
          input.title,
          input.message ?? null,
          input.entityType,
          input.entityId,
          input.actionUrl ?? null,
          input.priority ?? 'medium',
          input.category ?? null,
          input.dedupeKey ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return result.rows[0] ? mapNotification(result.rows[0]) : 'duplicate';
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'duplicate';
      }
      throw error;
    }
  }

  async markRead(
    organizationId: string,
    recipientUserId: string,
    notificationId: string,
  ) {
    const result = await db.query<NotificationRow>(
      `
        UPDATE notifications.notifications
        SET
          is_read = TRUE,
          read_at = COALESCE(read_at, NOW())
        WHERE id = $1
          AND organization_id = $2
          AND recipient_user_id = $3
        RETURNING ${NOTIFICATION_COLUMNS}
      `,
      [notificationId, organizationId, recipientUserId],
    );
    return result.rows[0] ? mapNotification(result.rows[0]) : null;
  }

  async markAllRead(organizationId: string, recipientUserId: string) {
    const result = await db.query(
      `
        UPDATE notifications.notifications
        SET
          is_read = TRUE,
          read_at = COALESCE(read_at, NOW())
        WHERE organization_id = $1
          AND recipient_user_id = $2
          AND is_read = FALSE
      `,
      [organizationId, recipientUserId],
    );
    return result.rowCount ?? 0;
  }

  async getDisplayName(userId: string) {
    const result = await db.query<{ full_name: string | null }>(
      `
        SELECT full_name
        FROM identity.user_profiles
        WHERE user_id = $1
      `,
      [userId],
    );
    const name = result.rows[0]?.full_name?.trim();
    return name && name.length > 0 ? name : null;
  }

  async getRecipientEmails(userIds: string[]) {
    const unique = [...new Set(userIds.filter(Boolean))];
    const map = new Map<string, { email: string; fullName: string | null }>();
    if (unique.length === 0) return map;

    const result = await db.query<{
      id: string;
      email: string | null;
      full_name: string | null;
    }>(
      `
        SELECT u.id, u.email, p.full_name
        FROM identity.users u
        LEFT JOIN identity.user_profiles p ON p.user_id = u.id
        WHERE u.id = ANY($1::uuid[])
      `,
      [unique],
    );

    for (const row of result.rows) {
      if (!row.email?.trim()) continue;
      map.set(row.id, {
        email: row.email.trim(),
        fullName: row.full_name?.trim() || null,
      });
    }
    return map;
  }
}
