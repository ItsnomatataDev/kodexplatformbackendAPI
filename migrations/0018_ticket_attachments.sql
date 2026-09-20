CREATE TABLE IF NOT EXISTS tickets.ticket_attachments (
    id UUID PRIMARY KEY,
    ticket_id UUID NOT NULL
        REFERENCES tickets.tickets(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    uploaded_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    bucket TEXT NOT NULL,
    object_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    content_type TEXT,
    size_bytes BIGINT,
    checksum TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, object_key)
);

CREATE INDEX IF NOT EXISTS tickets_ticket_attachments_ticket_idx
    ON tickets.ticket_attachments (organization_id, ticket_id, created_at ASC);

COMMENT ON TABLE tickets.ticket_attachments IS
    'Organization-scoped ticket file metadata. Object bytes live in MinIO under an org/tickets prefix.';

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{tickets,attachments}',
    COALESCE(permissions->'tickets'->'attachments', '{}'::jsonb) || '{
      "read": true,
      "create": true,
      "delete": true
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
