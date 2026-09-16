CREATE SCHEMA IF NOT EXISTS work;

CREATE TABLE IF NOT EXISTS work.projects (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
    owner_id UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    legacy_client_id UUID,
    legacy_campaign_id UUID,
    name TEXT NOT NULL,
    slug TEXT,
    description TEXT,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    due_date DATE,
    start_date DATE,
    completed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_billable BOOLEAN NOT NULL DEFAULT TRUE,
    budget_type TEXT,
    budget_limit NUMERIC(12, 2),
    billing_currency TEXT,
    default_hourly_rate NUMERIC(12, 2),
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id)
);

CREATE TABLE IF NOT EXISTS work.board_columns (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    project_id UUID REFERENCES work.projects(id) ON DELETE SET NULL,
    legacy_client_id UUID,
    name TEXT NOT NULL,
    color TEXT,
    status_key TEXT,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id)
);

CREATE TABLE IF NOT EXISTS work.cards (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    project_id UUID REFERENCES work.projects(id) ON DELETE SET NULL,
    parent_card_id UUID REFERENCES work.cards(id) ON DELETE SET NULL,
    column_id UUID REFERENCES work.board_columns(id) ON DELETE SET NULL,
    assigned_to UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    assigned_by UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    archived_by UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    legacy_client_id UUID,
    legacy_campaign_id UUID,
    legacy_office_id UUID,
    legacy_ticket_id UUID,
    title TEXT NOT NULL,
    description TEXT,
    status_key TEXT NOT NULL,
    priority TEXT NOT NULL,
    department TEXT,
    due_at TIMESTAMPTZ,
    start_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    blocked_reason TEXT,
    ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
    position INTEGER NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    tracked_seconds_cache INTEGER NOT NULL DEFAULT 0,
    is_billable BOOLEAN NOT NULL DEFAULT FALSE,
    estimated_seconds INTEGER NOT NULL DEFAULT 0,
    archived_at TIMESTAMPTZ,
    imported_time_status TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id)
);

CREATE TABLE IF NOT EXISTS work.card_comments (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL REFERENCES work.cards(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL,
    comment_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id)
);

CREATE TABLE IF NOT EXISTS work.labels (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    legacy_client_id UUID,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id)
);

CREATE TABLE IF NOT EXISTS work.card_label_assignments (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL REFERENCES work.cards(id) ON DELETE CASCADE,
    label_id UUID NOT NULL REFERENCES work.labels(id) ON DELETE CASCADE,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id),
    UNIQUE (card_id, label_id)
);

CREATE TABLE IF NOT EXISTS work.card_watchers (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL REFERENCES work.cards(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id),
    UNIQUE (card_id, user_id)
);

CREATE TABLE IF NOT EXISTS work.card_updates (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL REFERENCES work.cards(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    project_id UUID REFERENCES work.projects(id) ON DELETE SET NULL,
    user_id UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    update_type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id)
);

CREATE TABLE IF NOT EXISTS work.card_submissions (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL REFERENCES work.cards(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    submitted_by UUID NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
    reviewed_by UUID REFERENCES identity.users(id) ON DELETE SET NULL,
    submission_type TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT,
    link_url TEXT,
    file_path TEXT,
    file_name TEXT,
    mime_type TEXT,
    file_size BIGINT,
    approval_status TEXT NOT NULL,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id)
);

CREATE TABLE IF NOT EXISTS work.card_assignees (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL REFERENCES work.cards(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id),
    UNIQUE (card_id, user_id)
);

CREATE INDEX IF NOT EXISTS work_cards_organization_column_position_idx
    ON work.cards (organization_id, column_id, position);
CREATE INDEX IF NOT EXISTS work_cards_parent_card_idx ON work.cards (parent_card_id);
CREATE INDEX IF NOT EXISTS work_board_columns_organization_position_idx
    ON work.board_columns (organization_id, position);
CREATE INDEX IF NOT EXISTS work_card_comments_card_created_idx
    ON work.card_comments (card_id, created_at);
