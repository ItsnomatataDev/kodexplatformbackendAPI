-- Direct chat calls reuse meetings.meetings with extended lifecycle statuses.

ALTER TABLE meetings.meetings
  DROP CONSTRAINT IF EXISTS meetings_status_check;

ALTER TABLE meetings.meetings
  ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('scheduled', 'ringing', 'live', 'ended', 'cancelled', 'missed', 'declined'));

ALTER TABLE meetings.meetings
  ADD COLUMN IF NOT EXISTS e2ee_passphrase TEXT;

ALTER TABLE meetings.meetings
  ADD COLUMN IF NOT EXISTS conversation_id UUID;

ALTER TABLE meetings.participants
  ADD COLUMN IF NOT EXISTS invite_status TEXT NOT NULL DEFAULT 'accepted';

ALTER TABLE meetings.participants
  DROP CONSTRAINT IF EXISTS meetings_participants_invite_status_check;

ALTER TABLE meetings.participants
  ADD CONSTRAINT meetings_participants_invite_status_check
  CHECK (invite_status IN ('ringing', 'accepted', 'declined', 'left'));

CREATE INDEX IF NOT EXISTS meetings_conversation_id_idx
  ON meetings.meetings (conversation_id)
  WHERE conversation_id IS NOT NULL;
