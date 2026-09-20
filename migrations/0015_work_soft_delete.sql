ALTER TABLE work.time_entries
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS work_time_entries_active_card_idx
    ON work.time_entries (organization_id, card_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS work_cards_active_board_idx
    ON work.cards (organization_id, board_id)
    WHERE archived_at IS NULL;
