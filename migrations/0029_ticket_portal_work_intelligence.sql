-- Public ticket portal fields, ratings, and ITs No Matata work intelligence.

ALTER TABLE tickets.tickets
  ADD COLUMN IF NOT EXISTS tracking_token UUID,
  ADD COLUMN IF NOT EXISTS external_name TEXT,
  ADD COLUMN IF NOT EXISTS external_company TEXT,
  ADD COLUMN IF NOT EXISTS external_phone TEXT,
  ADD COLUMN IF NOT EXISTS closed_by_email TEXT;

UPDATE tickets.tickets
SET tracking_token = gen_random_uuid()
WHERE tracking_token IS NULL;

ALTER TABLE tickets.tickets
  ALTER COLUMN tracking_token SET DEFAULT gen_random_uuid(),
  ALTER COLUMN tracking_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_tracking_token_uidx
  ON tickets.tickets (tracking_token);

ALTER TABLE tickets.ticket_comments
  ADD COLUMN IF NOT EXISTS external_name TEXT,
  ADD COLUMN IF NOT EXISTS external_email TEXT;

CREATE TABLE IF NOT EXISTS tickets.ticket_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE
    REFERENCES tickets.tickets(id)
    ON DELETE CASCADE,
  organization_id UUID NOT NULL
    REFERENCES organizations.organizations(id)
    ON DELETE CASCADE,
  rating INTEGER NOT NULL
    CHECK (rating BETWEEN 1 AND 5),
  feedback TEXT,
  created_by UUID
    REFERENCES identity.users(id)
    ON DELETE SET NULL,
  external_email TEXT,
  rated_assignee_id UUID
    REFERENCES identity.users(id)
    ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ticket_ratings_org_idx
  ON tickets.ticket_ratings (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tickets.ticket_time_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL
    REFERENCES tickets.tickets(id)
    ON DELETE CASCADE,
  organization_id UUID NOT NULL
    REFERENCES organizations.organizations(id)
    ON DELETE CASCADE,
  user_id UUID NOT NULL
    REFERENCES identity.users(id)
    ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'focus',
  CONSTRAINT ticket_time_sessions_window_chk
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS ticket_time_sessions_ticket_idx
  ON tickets.ticket_time_sessions (ticket_id, started_at);

CREATE INDEX IF NOT EXISTS ticket_time_sessions_open_idx
  ON tickets.ticket_time_sessions (ticket_id, user_id)
  WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS tickets.ticket_work_estimates (
  ticket_id UUID PRIMARY KEY
    REFERENCES tickets.tickets(id)
    ON DELETE CASCADE,
  organization_id UUID NOT NULL
    REFERENCES organizations.organizations(id)
    ON DELETE CASCADE,
  minutes_low INTEGER,
  minutes_median INTEGER,
  minutes_high INTEGER,
  sample_count INTEGER NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT 'none',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ticket_work_estimates_org_idx
  ON tickets.ticket_work_estimates (organization_id);

COMMENT ON COLUMN tickets.tickets.tracking_token IS
  'Opaque public portal tracking token for external requesters.';
COMMENT ON TABLE tickets.ticket_time_sessions IS
  'Auto-tracked focus sessions for ITs No Matata ticket work intelligence.';
COMMENT ON TABLE tickets.ticket_work_estimates IS
  'Category-based duration estimates for ticket work intelligence.';
