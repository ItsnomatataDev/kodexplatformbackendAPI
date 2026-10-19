-- Run against an isolated database with migration 0062 applied. Always rolls back fixtures.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := gen_random_uuid();
  actor uuid := gen_random_uuid();
  technician uuid := gen_random_uuid();
  ticket uuid := gen_random_uuid();
  second_ticket uuid := gen_random_uuid();
  linked uuid;
  board uuid;
  stamp timestamptz;
BEGIN
  INSERT INTO organizations.organizations(id,name,slug) VALUES(org,'Ticket regression',org::text);
  INSERT INTO identity.users(id,email,account_status) VALUES
    (actor,'ticket-requester@example.test','active'),(technician,'technician@example.test','active');
  INSERT INTO tickets.tickets(id,organization_id,ticket_number,user_id,created_by,category,subject,description)
    VALUES(ticket,org,'TEST-1',actor,actor,'hardware','Test assignment','Regression fixture');
  IF EXISTS(SELECT 1 FROM work.cards WHERE organization_id=org) THEN RAISE EXCEPTION 'Unassigned ticket created card'; END IF;
  UPDATE tickets.tickets SET assigned_to=technician,status='assigned' WHERE id=ticket;
  SELECT linked_card_id,assigned_at INTO linked,stamp FROM tickets.tickets WHERE id=ticket;
  IF linked IS NULL OR stamp IS NULL THEN RAISE EXCEPTION 'Assignment missing card or timestamp'; END IF;
  SELECT board_id INTO board FROM work.cards WHERE id=linked AND assigned_to=technician;
  IF board IS NULL THEN RAISE EXCEPTION 'Missing board or card assignee'; END IF;
  IF NOT EXISTS(SELECT 1 FROM work.card_assignees WHERE card_id=linked AND user_id=technician) THEN RAISE EXCEPTION 'Missing assignee relation'; END IF;
  -- Set a historical known value to prove no-op assignment does not overwrite it.
  UPDATE tickets.tickets SET assigned_at='2020-01-01Z' WHERE id=ticket;
  UPDATE tickets.tickets SET assigned_to=technician WHERE id=ticket;
  IF (SELECT assigned_at FROM tickets.tickets WHERE id=ticket) <> '2020-01-01Z'::timestamptz THEN RAISE EXCEPTION 'No-op reset timestamp'; END IF;
  UPDATE tickets.tickets SET assigned_to=actor WHERE id=ticket;
  IF (SELECT assigned_at FROM tickets.tickets WHERE id=ticket) = '2020-01-01Z'::timestamptz THEN RAISE EXCEPTION 'Reassignment retained timestamp'; END IF;
  IF EXISTS(SELECT 1 FROM work.card_assignees WHERE card_id=linked AND user_id=technician) THEN RAISE EXCEPTION 'Stale assignee'; END IF;
  UPDATE tickets.tickets SET status='closed' WHERE id=ticket;
  IF NOT EXISTS(SELECT 1 FROM work.cards c JOIN work.board_columns col ON col.id=c.column_id WHERE c.id=linked AND c.status_key='review' AND col.status_key='review') THEN RAISE EXCEPTION 'Closed not in review'; END IF;
  UPDATE tickets.tickets SET status='resolved' WHERE id=ticket;
  IF NOT EXISTS(SELECT 1 FROM work.cards WHERE id=linked AND status_key='done' AND completed_at IS NOT NULL) THEN RAISE EXCEPTION 'Resolved not done'; END IF;
  UPDATE tickets.tickets SET status='reopened' WHERE id=ticket;
  IF NOT EXISTS(SELECT 1 FROM work.cards WHERE id=linked AND status_key='in_progress' AND completed_at IS NULL) THEN RAISE EXCEPTION 'Reopen failed'; END IF;
  UPDATE tickets.tickets SET assigned_to=NULL WHERE id=ticket;
  IF EXISTS(SELECT 1 FROM tickets.tickets WHERE id=ticket AND assigned_at IS NOT NULL) OR EXISTS(SELECT 1 FROM work.card_assignees WHERE card_id=linked) THEN RAISE EXCEPTION 'Unassignment failed'; END IF;
  UPDATE work.boards SET name='Support Tickets' WHERE id=board;
  INSERT INTO tickets.tickets(id,organization_id,ticket_number,created_by,assigned_to,category,subject,description)
    VALUES(second_ticket,org,'TEST-2',actor,technician,'hardware','Assigned at creation','Regression fixture');
  IF (SELECT count(*) FROM work.boards WHERE organization_id=org) <> 1 OR (SELECT count(*) FROM work.cards WHERE organization_id=org) <> 2 THEN RAISE EXCEPTION 'Duplicate board/card'; END IF;
  -- Migration repair leaves unknown history null and does not duplicate cards.
  UPDATE tickets.tickets SET assigned_at=NULL WHERE id=second_ticket;
  UPDATE tickets.tickets SET assigned_to=assigned_to WHERE organization_id=org AND assigned_to IS NOT NULL;
  IF (SELECT assigned_at FROM tickets.tickets WHERE id=second_ticket) IS NOT NULL THEN RAISE EXCEPTION 'Repair fabricated history'; END IF;
  IF (SELECT count(*) FROM work.cards WHERE organization_id=org) <> 2 THEN RAISE EXCEPTION 'Repair duplicated card'; END IF;
END $$;
ROLLBACK;
