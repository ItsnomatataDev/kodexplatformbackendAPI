CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE IF NOT EXISTS notifications.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    recipient_user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    actor_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    action_url TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    category TEXT,
    dedupe_key TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT notifications_type_check
        CHECK (type IN ('task_assigned', 'task_comment')),
    CONSTRAINT notifications_priority_check
        CHECK (priority IN ('low', 'medium', 'high', 'urgent'))
);

CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
    ON notifications.notifications (organization_id, recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx
    ON notifications.notifications (organization_id, recipient_user_id)
    WHERE is_read = FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_unique
    ON notifications.notifications (organization_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{notifications}',
    COALESCE(permissions->'notifications', '{}'::jsonb) || '{
      "read": true,
      "update": true
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
