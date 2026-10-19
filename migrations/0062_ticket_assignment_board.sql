-- Preserve unknown historical assignment times; updated_at is not assignment evidence.
ALTER TABLE tickets.tickets ADD COLUMN assigned_at TIMESTAMPTZ;

CREATE FUNCTION tickets.sync_assignment_board() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  board_uuid uuid;
  card_uuid uuid;
  column_uuid uuid;
  new_uuid uuid;
  office_uuid uuid;
  target_status text;
  assignment_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    assignment_changed := NEW.assigned_to IS NOT NULL;
  ELSE
    assignment_changed := NEW.assigned_to IS DISTINCT FROM OLD.assigned_to;
  END IF;
  IF assignment_changed THEN
    NEW.assigned_at := CASE WHEN NEW.assigned_to IS NULL THEN NULL ELSE NOW() END;
  END IF;

  -- Organization lock prevents concurrent first assignments creating duplicate boards.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 62));
  SELECT id, board_id INTO card_uuid, board_uuid FROM work.cards
  WHERE organization_id = NEW.organization_id
    AND (id = NEW.linked_card_id OR legacy_ticket_id = NEW.id)
  ORDER BY (id = NEW.linked_card_id) DESC NULLS LAST, created_at, id LIMIT 1;

  IF card_uuid IS NULL AND (NEW.assigned_to IS NULL OR NEW.archived_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF board_uuid IS NULL THEN
    SELECT id INTO board_uuid FROM work.boards
    WHERE organization_id = NEW.organization_id
      AND (lower(name) IN ('tickets', 'support tickets')
        OR slug = 'tickets-' || left(replace(NEW.organization_id::text, '-', ''), 8)
        OR metadata->>'source' = 'service_desk')
      AND archived_at IS NULL AND metadata->>'boardType' = 'internal'
    ORDER BY created_at, id LIMIT 1;
    IF board_uuid IS NULL THEN
      board_uuid := gen_random_uuid();
      SELECT office_id INTO office_uuid FROM organizations.memberships
      WHERE organization_id = NEW.organization_id AND user_id = NEW.assigned_to AND status = 'active'
      ORDER BY id LIMIT 1;
      INSERT INTO work.boards
        (id, organization_id, created_by, name, slug, metadata, legacy_source, legacy_id)
      VALUES (board_uuid, NEW.organization_id, COALESCE(NEW.created_by, NEW.assigned_to),
        'Tickets', 'tickets-' || board_uuid::text, jsonb_build_object('boardType','internal','source','service_desk','officeId',COALESCE(office_uuid, NEW.office_id)),
        'kode-ticket-board', board_uuid);
    END IF;
  END IF;

  target_status := CASE
    WHEN NEW.status = 'resolved' THEN 'done'
    WHEN NEW.status = 'closed' THEN 'review'
    WHEN NEW.status IN ('in_progress','waiting_for_requester','waiting_for_third_party','reopened') THEN 'in_progress'
    ELSE 'backlog' END;
  -- Initialize new ticket cards; existing cards need a column only on status changes.
  -- Assignment-only backfills must not alter another board's layout.
  INSERT INTO work.board_columns
    (id, organization_id, board_id, name, status_key, position, created_at, updated_at, legacy_source, legacy_id)
  SELECT gen_random_uuid(), NEW.organization_id, board_uuid, template.name, template.status_key,
    COALESCE((SELECT max(position) + 1 FROM work.board_columns WHERE board_id = board_uuid), 0) + template.position,
    NOW(), NOW(), 'kode-ticket-board', gen_random_uuid()
  FROM (VALUES ('Backlog','backlog',0), ('To Do','todo',1), ('In Progress','in_progress',2),
    ('Review','review',3), ('Done','done',4)) AS template(name, status_key, position)
  WHERE NOT EXISTS (SELECT 1 FROM work.board_columns col
    WHERE col.board_id = board_uuid AND col.status_key = template.status_key)
    AND (card_uuid IS NULL OR (TG_OP = 'UPDATE'
      AND NEW.status IS DISTINCT FROM OLD.status AND template.status_key = target_status));

  SELECT id INTO column_uuid FROM work.board_columns
  WHERE board_id = board_uuid AND organization_id = NEW.organization_id AND status_key = target_status
  ORDER BY position, id LIMIT 1;

  IF card_uuid IS NULL THEN
    card_uuid := gen_random_uuid();
    INSERT INTO work.cards
      (id, organization_id, board_id, column_id, assigned_to, created_by, legacy_office_id,
       legacy_ticket_id, title, description, status_key, priority, position, metadata,
       created_at, updated_at, legacy_source, legacy_id)
    VALUES (card_uuid, NEW.organization_id, board_uuid, column_uuid, NEW.assigned_to,
      NEW.created_by, NEW.office_id, NEW.id, '[' || NEW.ticket_number || '] ' || NEW.subject,
      NEW.description, target_status, NEW.priority, 0,
      jsonb_build_object('source','service_desk','ticket_id',NEW.id,'ticket_number',NEW.ticket_number),
      NOW(), NOW(), 'kode-ticket', NEW.id);
  ELSE
    UPDATE work.cards SET assigned_to = NEW.assigned_to, updated_at = NOW()
    WHERE id = card_uuid AND organization_id = NEW.organization_id;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE work.cards SET status_key = target_status, column_id = column_uuid,
          completed_at = CASE WHEN target_status = 'done' THEN NOW() ELSE NULL END
        WHERE id = card_uuid AND organization_id = NEW.organization_id;
      END IF;
    END IF;
  END IF;
  NEW.linked_card_id := card_uuid;
  -- Keep unrelated collaborators; remove only the previous ticket assignee.
  IF TG_OP = 'UPDATE' AND assignment_changed THEN
    DELETE FROM work.card_assignees WHERE card_id = card_uuid
      AND organization_id = NEW.organization_id AND user_id = OLD.assigned_to;
  END IF;
  IF NEW.assigned_to IS NOT NULL THEN
    new_uuid := gen_random_uuid();
    INSERT INTO work.card_assignees
      (id, card_id, user_id, organization_id, created_at, legacy_source, legacy_id)
    VALUES (new_uuid, card_uuid, NEW.assigned_to, NEW.organization_id, NOW(), 'kode-ticket', new_uuid)
    ON CONFLICT (card_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ticket_assignment_board
BEFORE INSERT OR UPDATE OF assigned_to, status ON tickets.tickets
FOR EACH ROW EXECUTE FUNCTION tickets.sync_assignment_board();

-- Repair existing active assignments without fabricating an assignment timestamp.
UPDATE tickets.tickets SET assigned_to = assigned_to
WHERE assigned_to IS NOT NULL AND archived_at IS NULL;
