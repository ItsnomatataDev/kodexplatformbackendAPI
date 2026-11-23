import { db } from '../db/pool.js';

export type PushSubscriptionRecord = {
  id: string;
  organizationId: string;
  userId: string;
  endpoint: string;
  platform: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type PushRow = {
  id: string;
  organization_id: string;
  user_id: string;
  endpoint: string;
  platform: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: PushRow): PushSubscriptionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    endpoint: row.endpoint,
    platform: row.platform,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresPushSubscriptionStore {
  async upsert(input: {
    organizationId: string;
    userId: string;
    endpoint: string;
    platform?: string | null;
  }) {
    const result = await db.query<PushRow>(
      `
        INSERT INTO notifications.push_subscriptions (
          organization_id, user_id, endpoint, platform, is_active, updated_at
        ) VALUES ($1, $2, $3, $4, TRUE, NOW())
        ON CONFLICT (user_id, endpoint)
        DO UPDATE SET
          organization_id = EXCLUDED.organization_id,
          platform = EXCLUDED.platform,
          is_active = TRUE,
          updated_at = NOW()
        RETURNING *
      `,
      [
        input.organizationId,
        input.userId,
        input.endpoint.trim(),
        (input.platform ?? 'unknown').trim() || 'unknown',
      ],
    );
    return mapRow(result.rows[0]!);
  }

  async listActiveForUser(organizationId: string, userId: string) {
    const result = await db.query<PushRow>(
      `
        SELECT *
        FROM notifications.push_subscriptions
        WHERE organization_id = $1
          AND user_id = $2
          AND is_active = TRUE
        ORDER BY updated_at DESC
      `,
      [organizationId, userId],
    );
    return result.rows.map(mapRow);
  }

  async listActiveEndpointsForUsers(userIds: string[]) {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return [] as PushSubscriptionRecord[];
    const result = await db.query<PushRow>(
      `
        SELECT *
        FROM notifications.push_subscriptions
        WHERE user_id = ANY($1::uuid[])
          AND is_active = TRUE
      `,
      [unique],
    );
    return result.rows.map(mapRow);
  }

  async deactivateForUser(params: {
    organizationId: string;
    userId: string;
    endpointPrefix?: string | null;
  }) {
    const result = await db.query(
      `
        UPDATE notifications.push_subscriptions
        SET is_active = FALSE, updated_at = NOW()
        WHERE organization_id = $1
          AND user_id = $2
          AND is_active = TRUE
          AND ($3::text IS NULL OR endpoint LIKE $3)
      `,
      [
        params.organizationId,
        params.userId,
        params.endpointPrefix ? `${params.endpointPrefix}%` : null,
      ],
    );
    return result.rowCount ?? 0;
  }

  async deactivateEndpoint(endpoint: string) {
    await db.query(
      `
        UPDATE notifications.push_subscriptions
        SET is_active = FALSE, updated_at = NOW()
        WHERE endpoint = $1 AND is_active = TRUE
      `,
      [endpoint],
    );
  }
}
