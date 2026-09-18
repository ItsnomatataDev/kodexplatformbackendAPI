UPDATE organizations.roles
SET
  permissions = COALESCE(permissions, '{}'::jsonb) || '{
    "work": {
      "attachments": {"read": true, "create": true, "delete": true},
      "submissions": {"read": true, "create": true, "update": true}
    }
  }'::jsonb,
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
