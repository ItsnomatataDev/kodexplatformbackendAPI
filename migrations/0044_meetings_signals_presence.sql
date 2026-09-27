-- Phase 2B: targeted signals + participant presence for meetings cutover.

ALTER TABLE meetings.signals
  ADD COLUMN IF NOT EXISTS receiver_id UUID
    REFERENCES identity.users(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS meetings_signals_receiver_created_idx
  ON meetings.signals (meeting_id, receiver_id, created_at DESC);

ALTER TABLE meetings.participants
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

ALTER TABLE meetings.guests
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
