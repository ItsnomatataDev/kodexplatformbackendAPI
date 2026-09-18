CREATE TABLE IF NOT EXISTS work.card_checklists (
    id UUID PRIMARY KEY,
    card_id UUID NOT NULL
        REFERENCES work.cards(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    title TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id),
    CONSTRAINT work_card_checklists_position_check CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS work_card_checklists_card_idx
    ON work.card_checklists (organization_id, card_id, position, created_at);

CREATE TABLE IF NOT EXISTS work.card_checklist_items (
    id UUID PRIMARY KEY,
    checklist_id UUID NOT NULL
        REFERENCES work.card_checklists(id)
        ON DELETE CASCADE,
    card_id UUID NOT NULL
        REFERENCES work.cards(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    completed_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    content TEXT NOT NULL,
    is_completed BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id),
    CONSTRAINT work_card_checklist_items_position_check CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS work_card_checklist_items_checklist_idx
    ON work.card_checklist_items (organization_id, checklist_id, position, created_at);

CREATE INDEX IF NOT EXISTS work_card_checklist_items_card_idx
    ON work.card_checklist_items (organization_id, card_id);

COMMENT ON TABLE work.card_checklists IS
    'Organization-scoped checklists belonging to a work card.';

COMMENT ON TABLE work.card_checklist_items IS
    'Organization-scoped checklist items belonging to a work card checklist.';

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{work}',
    COALESCE(permissions->'work', '{}'::jsonb) || '{
      "boards": {"read": true, "create": true, "update": true},
      "board_columns": {"read": true, "create": true, "update": true},
      "cards": {"read": true, "create": true, "update": true},
      "card_comments": {"read": true, "create": true, "update": true},
      "card_assignees": {"read": true, "create": true, "delete": true},
      "attachments": {"read": true, "create": true, "delete": true},
      "submissions": {"read": true, "create": true, "update": true},
      "checklists": {"read": true, "create": true, "update": true, "delete": true}
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN (
  'admin',
  'manager',
  'it',
  'media_team',
  'social_media',
  'seo_specialist'
)
AND is_active = TRUE;
