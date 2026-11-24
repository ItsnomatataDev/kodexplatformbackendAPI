UPDATE organizations.roles AS role
SET
  permissions = COALESCE(role.permissions, '{}'::jsonb) || jsonb_build_object(
    'work',
    COALESCE(role.permissions->'work', '{}'::jsonb) || jsonb_build_object(
      'boards',
      (COALESCE(role.permissions->'work'->'boards', '{}'::jsonb) || '{"read": true}'::jsonb),
      'board_columns',
      (COALESCE(role.permissions->'work'->'board_columns', '{}'::jsonb) || '{"read": true}'::jsonb),
      'cards',
      (COALESCE(role.permissions->'work'->'cards', '{}'::jsonb) || '{"read": true}'::jsonb),
      'card_comments',
      (COALESCE(role.permissions->'work'->'card_comments', '{}'::jsonb) || '{"read": true}'::jsonb),
      'card_assignees',
      (COALESCE(role.permissions->'work'->'card_assignees', '{}'::jsonb) || '{"read": true}'::jsonb),
      'card_labels',
      (COALESCE(role.permissions->'work'->'card_labels', '{}'::jsonb) || '{"read": true}'::jsonb),
      'card_watchers',
      (COALESCE(role.permissions->'work'->'card_watchers', '{}'::jsonb) || '{"read": true}'::jsonb),
      'card_updates',
      (COALESCE(role.permissions->'work'->'card_updates', '{}'::jsonb) || '{"read": true}'::jsonb),
      'attachments',
      (COALESCE(role.permissions->'work'->'attachments', '{}'::jsonb) || '{"read": true}'::jsonb),
      'submissions',
      (COALESCE(role.permissions->'work'->'submissions', '{}'::jsonb) || '{"read": true}'::jsonb),
      'time_entries',
      (COALESCE(role.permissions->'work'->'time_entries', '{}'::jsonb) || '{"read": true}'::jsonb),
      'checklists',
      (COALESCE(role.permissions->'work'->'checklists', '{}'::jsonb) || '{"read": true}'::jsonb),
      'labels',
      (COALESCE(role.permissions->'work'->'labels', '{}'::jsonb) || '{"read": true}'::jsonb)
    )
  ),
  updated_at = NOW()
WHERE role.role_key IN ('media_team', 'social_media')
  AND role.is_active = TRUE;
