CREATE TABLE IF NOT EXISTS work.card_attachments (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL
        REFERENCES work.cards(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    uploaded_by UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    bucket TEXT NOT NULL,
    object_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    content_type TEXT,
    size_bytes BIGINT,
    checksum TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, object_key)
);

CREATE INDEX IF NOT EXISTS work_card_attachments_card_idx
    ON work.card_attachments (organization_id, card_id);

CREATE TABLE IF NOT EXISTS work.time_entries (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL
        REFERENCES work.cards(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    created_by UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    seconds INTEGER NOT NULL,
    note TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    is_billable BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT work_time_entries_seconds_check CHECK (seconds >= 0)
);

CREATE INDEX IF NOT EXISTS work_time_entries_card_idx
    ON work.time_entries (organization_id, card_id);

CREATE INDEX IF NOT EXISTS work_labels_organization_idx
    ON work.labels (organization_id);

CREATE INDEX IF NOT EXISTS work_card_comments_organization_card_idx
    ON work.card_comments (organization_id, card_id);

CREATE INDEX IF NOT EXISTS work_card_watchers_organization_card_idx
    ON work.card_watchers (organization_id, card_id);

CREATE INDEX IF NOT EXISTS work_card_assignees_organization_card_idx
    ON work.card_assignees (organization_id, card_id);

CREATE INDEX IF NOT EXISTS work_card_submissions_organization_card_idx
    ON work.card_submissions (organization_id, card_id);

CREATE INDEX IF NOT EXISTS work_card_updates_organization_card_idx
    ON work.card_updates (organization_id, card_id, created_at);

ALTER TABLE work.card_label_assignments
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON TABLE work.card_attachments IS
    'Organization-scoped card file metadata. Object bytes live in MinIO under an org-prefixed key.';

COMMENT ON TABLE work.time_entries IS
    'Organization-scoped time entries belonging to a card.';
