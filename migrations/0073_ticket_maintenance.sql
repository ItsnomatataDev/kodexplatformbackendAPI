ALTER TABLE tickets.tickets
    ADD COLUMN IF NOT EXISTS auto_aged_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS awaiting_requester_close_since TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_outstanding_reminder_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_responder_activity_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE tickets.tickets
SET awaiting_requester_close_since = COALESCE(awaiting_requester_close_since, updated_at)
WHERE status = 'waiting_for_requester'
  AND awaiting_requester_close_since IS NULL;

CREATE INDEX IF NOT EXISTS tickets_maintenance_idx
    ON tickets.tickets (status, archived_at, updated_at)
    WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION tickets.process_maintenance(p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_aged integer := 0;
    v_closed integer := 0;
    v_archived integer := 0;
    v_reminded integer := 0;
    r record;
    v_last_activity timestamptz;
    v_waiting_since timestamptz;
    v_new_status text;
    v_action text;
    v_terminal_at timestamptz;
BEGIN
    FOR r IN
        SELECT ticket.*
        FROM tickets.tickets ticket
        WHERE ticket.archived_at IS NULL
          AND ticket.status IN ('open', 'assigned', 'in_progress')
        ORDER BY ticket.id
        FOR UPDATE OF ticket SKIP LOCKED
    LOOP
        SELECT GREATEST(
            r.updated_at,
            r.created_at,
            COALESCE(
                (SELECT MAX(comment.created_at)
                 FROM tickets.ticket_comments comment
                 WHERE comment.ticket_id = r.id),
                r.created_at
            )
        ) INTO v_last_activity;

        IF v_last_activity > p_now - INTERVAL '7 days' THEN
            CONTINUE;
        END IF;

        v_new_status := NULL;
        IF r.status = 'open' AND r.assigned_to IS NOT NULL THEN
            v_new_status := 'assigned';
        ELSIF r.status = 'assigned' THEN
            v_new_status := 'in_progress';
        ELSIF r.status = 'in_progress' THEN
            v_new_status := 'waiting_for_requester';
        END IF;

        IF v_new_status IS NULL THEN
            CONTINUE;
        END IF;

        UPDATE tickets.tickets
        SET
            status = v_new_status,
            auto_aged_at = p_now,
            awaiting_requester_close_since = CASE
                WHEN v_new_status = 'waiting_for_requester'
                    THEN COALESCE(awaiting_requester_close_since, p_now)
                ELSE NULL
            END,
            updated_at = p_now
        WHERE id = r.id;

        v_aged := v_aged + 1;
    END LOOP;

    FOR r IN
        SELECT ticket.*
        FROM tickets.tickets ticket
        WHERE ticket.archived_at IS NULL
          AND ticket.status = 'waiting_for_requester'
        ORDER BY ticket.id
        FOR UPDATE OF ticket SKIP LOCKED
    LOOP
        v_waiting_since := COALESCE(
            r.awaiting_requester_close_since,
            r.updated_at,
            r.created_at
        );
        IF v_waiting_since > p_now - INTERVAL '7 days' THEN
            CONTINUE;
        END IF;

        v_action := NULLIF(BTRIM(COALESCE(r.action_taken, '')), '');
        IF v_action IS NULL OR CHAR_LENGTH(v_action) < 20 THEN
            v_action := 'No requester response after 7 days. Ticket auto-closed.';
        END IF;

        UPDATE tickets.tickets
        SET
            status = 'closed',
            closed_at = COALESCE(closed_at, p_now),
            action_taken = v_action,
            auto_aged_at = p_now,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'auto_closed_waiting_requester', true,
                'auto_closed_waiting_requester_at', p_now
            ),
            updated_at = p_now
        WHERE id = r.id;

        v_closed := v_closed + 1;
    END LOOP;

    FOR r IN
        SELECT ticket.*
        FROM tickets.tickets ticket
        WHERE ticket.archived_at IS NULL
          AND ticket.assigned_to IS NOT NULL
          AND ticket.status NOT IN ('resolved', 'closed')
        ORDER BY ticket.id
        FOR UPDATE OF ticket SKIP LOCKED
    LOOP
        SELECT COALESCE(
            r.last_responder_activity_at,
            (SELECT MAX(comment.created_at)
             FROM tickets.ticket_comments comment
             WHERE comment.ticket_id = r.id
               AND comment.author_type = 'internal'),
            r.created_at
        ) INTO v_last_activity;

        IF v_last_activity > p_now - INTERVAL '3 days' THEN
            CONTINUE;
        END IF;
        IF r.last_outstanding_reminder_at IS NOT NULL
           AND r.last_outstanding_reminder_at > p_now - INTERVAL '3 days' THEN
            CONTINUE;
        END IF;

        INSERT INTO notifications.notifications (
            organization_id,
            recipient_user_id,
            type,
            title,
            message,
            entity_type,
            entity_id,
            action_url,
            priority,
            category,
            dedupe_key,
            metadata
        )
        VALUES (
            r.organization_id,
            r.assigned_to,
            'ticket_outstanding',
            format('Outstanding ticket: %s', r.ticket_number),
            format(
                '%s has had no technician update in 3+ days. Please reply or update status.',
                r.subject
            ),
            'ticket',
            r.id,
            format('/it/support/%s', r.id),
            CASE WHEN r.priority = 'urgent' THEN 'high' ELSE 'medium' END,
            'service_desk',
            format('ticket-outstanding:%s:%s', r.id, to_char(p_now, 'YYYY-MM-DD')),
            jsonb_build_object('event', 'ticket_outstanding', 'ticketNumber', r.ticket_number)
        )
        ON CONFLICT (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL
        DO NOTHING;

        UPDATE tickets.tickets
        SET last_outstanding_reminder_at = p_now
        WHERE id = r.id;

        v_reminded := v_reminded + 1;
    END LOOP;

    FOR r IN
        SELECT ticket.*
        FROM tickets.tickets ticket
        WHERE ticket.archived_at IS NULL
          AND ticket.status IN ('closed', 'resolved')
        ORDER BY ticket.id
        FOR UPDATE OF ticket SKIP LOCKED
    LOOP
        v_terminal_at := COALESCE(r.resolved_at, r.closed_at, r.updated_at);
        IF v_terminal_at IS NULL OR v_terminal_at > p_now - INTERVAL '7 days' THEN
            CONTINUE;
        END IF;

        UPDATE tickets.tickets
        SET
            archived_at = p_now,
            updated_at = p_now
        WHERE id = r.id;

        UPDATE work.cards card
        SET
            archived_at = COALESCE(card.archived_at, p_now),
            archived_by = COALESCE(card.archived_by, r.assigned_to, r.created_by),
            updated_at = p_now
        WHERE card.organization_id = r.organization_id
          AND card.archived_at IS NULL
          AND (
            card.id = r.linked_card_id
            OR card.legacy_ticket_id = r.id
          );

        v_archived := v_archived + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'aged', v_aged,
        'closed', v_closed,
        'archived', v_archived,
        'reminded', v_reminded
    );
END;
$$;
