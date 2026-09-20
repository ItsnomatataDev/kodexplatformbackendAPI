CREATE SCHEMA IF NOT EXISTS tickets;

CREATE TABLE IF NOT EXISTS tickets.tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    linked_card_id UUID
        REFERENCES work.cards(id)
        ON DELETE SET NULL,
    ticket_number TEXT NOT NULL,
    requester_type TEXT NOT NULL DEFAULT 'internal',
    user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    assigned_to UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    requester_email TEXT,
    category TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    action_taken TEXT,
    archived_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    closed_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tickets_requester_type_check
        CHECK (requester_type IN ('internal', 'external')),
    CONSTRAINT tickets_status_check
        CHECK (status IN (
            'open',
            'assigned',
            'in_progress',
            'waiting_for_requester',
            'waiting_for_third_party',
            'resolved',
            'closed',
            'reopened'
        )),
    CONSTRAINT tickets_priority_check
        CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    CONSTRAINT tickets_number_org_unique UNIQUE (organization_id, ticket_number)
);

CREATE INDEX IF NOT EXISTS tickets_org_created_idx
    ON tickets.tickets (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tickets_org_status_idx
    ON tickets.tickets (organization_id, status)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS tickets_org_assignee_idx
    ON tickets.tickets (organization_id, assigned_to)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS tickets_linked_card_idx
    ON tickets.tickets (organization_id, linked_card_id)
    WHERE linked_card_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tickets.ticket_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL
        REFERENCES tickets.tickets(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    author_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    author_type TEXT NOT NULL DEFAULT 'internal',
    body TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ticket_comments_author_type_check
        CHECK (author_type IN ('internal', 'external')),
    CONSTRAINT ticket_comments_visibility_check
        CHECK (visibility IN ('public', 'internal'))
);

CREATE INDEX IF NOT EXISTS ticket_comments_ticket_idx
    ON tickets.ticket_comments (organization_id, ticket_id, created_at ASC);

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{tickets}',
    COALESCE(permissions->'tickets', '{}'::jsonb) || '{
      "read": true,
      "create": true,
      "update": true,
      "comment": true
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

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{tickets}',
    COALESCE(permissions->'tickets', '{}'::jsonb) || '{
      "assign": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN (
  'admin',
  'manager',
  'it'
)
AND is_active = TRUE;
