BEGIN;

UPDATE organizations.roles
SET
    permissions = jsonb_set(
        COALESCE(permissions, '{}'::jsonb),
        '{content_studio}',
        COALESCE(permissions->'content_studio', '{}'::jsonb) || '{
            "read": true,
            "manage": true
        }'::jsonb
    ),
    updated_at = NOW()
WHERE role_key IN ('media_team', 'social_media')
  AND is_active = TRUE;

COMMIT;
