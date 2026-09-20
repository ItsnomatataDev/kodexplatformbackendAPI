UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{work}',
    COALESCE(permissions->'work', '{}'::jsonb) || '{
      "cards": {"read": true, "create": true, "update": true, "delete": true},
      "time_entries": {"read": true, "create": true, "update": true, "delete": true},
      "card_watchers": {"read": true, "create": true, "delete": true},
      "card_labels": {"read": true, "create": true, "delete": true},
      "labels": {"read": true, "create": true, "update": true}
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
