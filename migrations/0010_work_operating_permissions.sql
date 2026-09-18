UPDATE organizations.roles
SET
  permissions = COALESCE(permissions, '{}'::jsonb) || '{
    "work": {
      "boards": {"read": true, "create": true, "update": true},
      "board_columns": {"read": true, "create": true, "update": true},
      "cards": {"read": true, "create": true, "update": true},
      "card_comments": {"read": true, "create": true, "update": true},
      "card_assignees": {"read": true, "create": true, "delete": true}
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
