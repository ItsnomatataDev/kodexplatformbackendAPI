CREATE SCHEMA IF NOT EXISTS obligations;

CREATE TABLE IF NOT EXISTS obligations.monthly_obligations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    due_day_of_month INT NOT NULL CHECK (due_day_of_month BETWEEN 1 AND 28),
    assignee_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS obligations_org_active_idx
    ON obligations.monthly_obligations (organization_id, is_active);
CREATE INDEX IF NOT EXISTS obligations_assignee_idx
    ON obligations.monthly_obligations (assignee_id, is_active);

CREATE TABLE IF NOT EXISTS obligations.occurrences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obligation_id UUID NOT NULL
        REFERENCES obligations.monthly_obligations(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    period_year INT NOT NULL,
    period_month INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    due_on DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'due', 'overdue', 'submitted', 'skipped')),
    submitted_at TIMESTAMPTZ,
    submitted_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    submission_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT obligations_occurrences_period_uq
        UNIQUE (obligation_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS obligations_occurrences_org_period_idx
    ON obligations.occurrences (organization_id, period_year, period_month);
