CREATE TABLE IF NOT EXISTS obligations.handovers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    obligation_id UUID NOT NULL REFERENCES obligations.monthly_obligations(id) ON DELETE CASCADE,
    from_user_id UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    to_user_id UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    actor_user_id UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS obligation_handovers_history_idx
    ON obligations.handovers (organization_id, obligation_id, created_at DESC);
