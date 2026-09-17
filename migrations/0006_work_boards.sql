-- Replace the unused Project container with a Kode-native Board container.
-- work.projects, work.board_columns, and work.cards are required to be empty.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM work.projects)
     OR EXISTS (SELECT 1 FROM work.board_columns)
     OR EXISTS (SELECT 1 FROM work.cards)
     OR EXISTS (SELECT 1 FROM work.card_updates)
  THEN
    RAISE EXCEPTION
      'Refusing Work board migration because Work tables are not empty.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS work.boards (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    created_by UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    owner_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    name TEXT NOT NULL,
    slug TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    legacy_client_id UUID,
    legacy_source TEXT NOT NULL,
    legacy_id UUID NOT NULL,
    UNIQUE (legacy_source, legacy_id)
);

ALTER TABLE work.board_columns
    DROP COLUMN project_id,
    ADD COLUMN board_id UUID NOT NULL
        REFERENCES work.boards(id)
        ON DELETE CASCADE;

ALTER TABLE work.cards
    DROP COLUMN project_id,
    ADD COLUMN board_id UUID NOT NULL
        REFERENCES work.boards(id)
        ON DELETE CASCADE;

ALTER TABLE work.card_updates
    DROP COLUMN project_id,
    ADD COLUMN board_id UUID
        REFERENCES work.boards(id)
        ON DELETE SET NULL;

DROP TABLE work.projects;

CREATE INDEX IF NOT EXISTS work_boards_organization_idx
    ON work.boards (organization_id);

CREATE INDEX IF NOT EXISTS work_boards_organization_position_idx
    ON work.boards (organization_id, position)
    WHERE archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS work_boards_organization_slug_idx
    ON work.boards (organization_id, slug)
    WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS work_board_columns_board_position_idx
    ON work.board_columns (organization_id, board_id, position);

CREATE INDEX IF NOT EXISTS work_cards_board_idx
    ON work.cards (organization_id, board_id);

CREATE INDEX IF NOT EXISTS work_card_updates_board_idx
    ON work.card_updates (board_id);

COMMENT ON TABLE work.boards IS
    'Organization-scoped Work boards. Columns and cards belong to a board.';
