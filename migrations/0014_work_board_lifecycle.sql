UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{work}',
    COALESCE(permissions->'work', '{}'::jsonb) || '{
      "boards": {"read": true, "create": true, "update": true, "delete": true},
      "board_columns": {"read": true, "create": true, "update": true, "delete": true}
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
