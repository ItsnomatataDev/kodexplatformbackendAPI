import type { Pool } from 'pg';
import { db } from '../db/pool.js';

export type PlaybackRow = {
  id: string;
  type: 'video' | 'image';
  bucket: string;
  storage_path: string;
  mime_type: string | null;
};
export type PlaybackSelection = {
  schedule_exists: boolean;
  anchor_exists: boolean;
  assets: PlaybackRow[];
};
export interface SchedulePlaybackStore {
  select(organizationId: string, scheduleId: string, finishedId: string | null): Promise<PlaybackSelection>;
}

// The anchor is drawn from the entire timeline, even if it was deselected
// after playback began. Eligibility applies only to the returned successors.
export const SCHEDULE_PLAYBACK_SQL = `
WITH owned_schedule AS (
  SELECT id FROM content.schedules
  WHERE id = $2::uuid AND organization_id = $1::uuid
), anchor AS (
  SELECT a.display_slot, a.sort_order, a.created_at, a.id
  FROM content.schedule_assets a
  JOIN owned_schedule s ON s.id = a.schedule_id
  WHERE a.organization_id = $1::uuid AND a.id = $3::uuid
), upcoming AS (
  SELECT a.id, a.asset_type AS type, a.bucket, a.storage_path, a.mime_type,
         a.display_slot, a.sort_order, a.created_at
  FROM content.schedule_assets a
  JOIN owned_schedule s ON s.id = a.schedule_id
  WHERE a.organization_id = $1::uuid
    AND a.is_selected = TRUE
    AND a.asset_type IN ('video', 'image')
    AND NULLIF(BTRIM(a.storage_path), '') IS NOT NULL
    AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
    AND ($3::uuid IS NULL OR
      (a.display_slot, a.sort_order, a.created_at, a.id) >
      (SELECT display_slot, sort_order, created_at, id FROM anchor))
  ORDER BY a.display_slot, a.sort_order, a.created_at, a.id
  LIMIT 2
)
SELECT EXISTS(SELECT 1 FROM owned_schedule) AS schedule_exists,
       ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM anchor)) AS anchor_exists,
       COALESCE((SELECT jsonb_agg(
         jsonb_build_object('id', id, 'type', type, 'bucket', bucket,
                           'storage_path', storage_path, 'mime_type', mime_type)
         ORDER BY display_slot, sort_order, created_at, id
       ) FROM upcoming), '[]'::jsonb) AS assets
`;

export class PostgresSchedulePlaybackStore implements SchedulePlaybackStore {
  constructor(private readonly pool: Pick<Pool, 'query'> = db) {}

  async select(organizationId: string, scheduleId: string, finishedId: string | null) {
    const { rows } = await this.pool.query<PlaybackSelection>(SCHEDULE_PLAYBACK_SQL, [
      organizationId, scheduleId, finishedId,
    ]);
    return rows[0]!;
  }
}
