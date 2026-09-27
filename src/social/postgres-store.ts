import { listLimit } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { NotFoundError } from '../http/errors.js';

function mapPost(row: Record<string, unknown>) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    client_id: row.client_id ?? null,
    campaign_id: row.campaign_id ?? null,
    title: row.title,
    body: row.body ?? null,
    platform: row.platform,
    status: row.status,
    priority: row.priority,
    scheduled_for: row.scheduled_for ? (row.scheduled_for as Date).toISOString() : null,
    estimated_hours: Number(row.estimated_hours ?? 0),
    spent_hours: Number(row.spent_hours ?? 0),
    ai_angle: row.ai_angle ?? null,
    owner_id: row.owner_id ?? null,
    created_by: row.created_by ?? null,
    metadata: row.metadata ?? {},
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

export class PostgresSocialStore {
  async list(
    organizationId: string,
    filters: {
      clientId?: string;
      campaignId?: string;
      status?: string;
      limit?: number;
      beforeCreatedAt?: string;
      beforeId?: string;
    } = {},
  ) {
    const params: unknown[] = [organizationId];
    let where = 'organization_id = $1';
    if (filters.clientId) { params.push(filters.clientId); where += ` AND client_id = $${params.length}`; }
    if (filters.campaignId) { params.push(filters.campaignId); where += ` AND campaign_id = $${params.length}`; }
    if (filters.status) { params.push(filters.status); where += ` AND status = $${params.length}`; }
    if (filters.beforeCreatedAt && filters.beforeId) {
      params.push(filters.beforeCreatedAt, filters.beforeId);
      where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    const limit = listLimit(filters.limit);
    params.push(limit + 1);
    const result = await db.query(
      `SELECT * FROM social.posts WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const posts = result.rows.map(mapPost);
    return {
      posts: posts.slice(0, limit),
      hasMore: posts.length > limit,
    };
  }

  async create(organizationId: string, createdBy: string, input: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO social.posts (
         organization_id, client_id, campaign_id, title, body, platform, status, priority,
         scheduled_for, estimated_hours, spent_hours, ai_angle, owner_id, created_by, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'draft'),COALESCE($8,'medium'),$9,COALESCE($10,1),COALESCE($11,0),$12,$13,$14,COALESCE($15,'{}'::jsonb))
       RETURNING *`,
      [
        organizationId,
        input.clientId ?? input.client_id ?? null,
        input.campaignId ?? input.campaign_id ?? null,
        input.title,
        input.body ?? null,
        input.platform,
        input.status ?? 'draft',
        input.priority ?? 'medium',
        input.scheduledFor ?? input.scheduled_for ?? null,
        input.estimatedHours ?? input.estimated_hours ?? 1,
        input.spentHours ?? input.spent_hours ?? 0,
        input.aiAngle ?? input.ai_angle ?? null,
        input.ownerId ?? input.owner_id ?? createdBy,
        createdBy,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapPost(result.rows[0]);
  }

  async update(organizationId: string, postId: string, input: Record<string, unknown>) {
    const result = await db.query(
      `UPDATE social.posts
       SET title = COALESCE($3, title),
           body = COALESCE($4, body),
           platform = COALESCE($5, platform),
           status = COALESCE($6, status),
           priority = COALESCE($7, priority),
           scheduled_for = COALESCE($8, scheduled_for),
           estimated_hours = COALESCE($9, estimated_hours),
           spent_hours = COALESCE($10, spent_hours),
           ai_angle = COALESCE($11, ai_angle),
           owner_id = COALESCE($12, owner_id),
           client_id = COALESCE($13, client_id),
           campaign_id = COALESCE($14, campaign_id),
           metadata = COALESCE($15, metadata),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        postId,
        input.title ?? null,
        input.body ?? null,
        input.platform ?? null,
        input.status ?? null,
        input.priority ?? null,
        input.scheduled_for ?? input.scheduledFor ?? null,
        input.estimated_hours ?? input.estimatedHours ?? null,
        input.spent_hours ?? input.spentHours ?? null,
        input.ai_angle ?? input.aiAngle ?? null,
        input.owner_id ?? input.ownerId ?? null,
        input.client_id ?? input.clientId ?? null,
        input.campaign_id ?? input.campaignId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
    if (!result.rows[0]) throw new NotFoundError('SOCIAL_POST_NOT_FOUND', 'Social post not found.');
    return mapPost(result.rows[0]);
  }

  async delete(organizationId: string, postId: string) {
    const result = await db.query(
      `DELETE FROM social.posts WHERE organization_id = $1 AND id = $2 RETURNING id`,
      [organizationId, postId],
    );
    if (!result.rows[0]) throw new NotFoundError('SOCIAL_POST_NOT_FOUND', 'Social post not found.');
  }
}
