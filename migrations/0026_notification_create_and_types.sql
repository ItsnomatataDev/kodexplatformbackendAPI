-- Allow product domains (leave, content studio, service desk, etc.) to create
-- in-app notifications without a hard-coded type enum.
ALTER TABLE notifications.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (char_length(type) BETWEEN 1 AND 80);

-- Staff roles may create notifications (inbox create + email delivery).
UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{notifications}',
    COALESCE(permissions->'notifications', '{}'::jsonb) || '{
      "read": true,
      "update": true,
      "create": true
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
