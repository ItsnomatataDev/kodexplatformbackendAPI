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
WHERE is_active = TRUE
  AND COALESCE((permissions->'tickets'->>'read')::boolean, FALSE) = TRUE;
