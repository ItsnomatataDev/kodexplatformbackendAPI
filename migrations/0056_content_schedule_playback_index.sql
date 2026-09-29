-- Complete deterministic ordering for the stateless look-ahead seek.
CREATE INDEX IF NOT EXISTS content_schedule_assets_playback_idx
ON content.schedule_assets
  (organization_id, schedule_id, display_slot, sort_order, created_at, id);
