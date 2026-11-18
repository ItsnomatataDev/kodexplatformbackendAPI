CREATE TABLE IF NOT EXISTS work.manual_time_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    card_id UUID NOT NULL
        REFERENCES work.cards(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    created_by UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    seconds INTEGER NOT NULL,
    note TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    is_billable BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    time_entry_id UUID
        REFERENCES work.time_entries(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT manual_time_requests_seconds_range
        CHECK (seconds > 0 AND seconds <= 86400),
    CONSTRAINT manual_time_requests_status_valid
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    CONSTRAINT manual_time_requests_reason_present
        CHECK (length(btrim(reason)) > 0),
    CONSTRAINT manual_time_requests_window_valid
        CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS manual_time_requests_org_status_idx
    ON work.manual_time_requests (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS manual_time_requests_user_idx
    ON work.manual_time_requests (organization_id, user_id, created_at DESC);
