ALTER TABLE work.time_entries
    ADD COLUMN IF NOT EXISTS auto_stopped_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS work_time_entries_running_cutoff_idx
    ON work.time_entries (organization_id, started_at)
    WHERE started_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL;

COMMENT ON COLUMN work.time_entries.auto_stopped_at IS
    'Daily 18:00 Africa/Harare cutoff at which this timer was automatically stopped. Resume creates a new entry.';
