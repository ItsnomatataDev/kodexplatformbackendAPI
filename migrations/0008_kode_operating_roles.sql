-- Kode operating-role vocabulary cleanup.
--
-- The six intended current roles stay present and active.
-- The nine legacy tourism/finance roles are retained as inactive historical
-- rows. They are not deleted: memberships.role_id ON DELETE SET NULL, and
-- identity import preserves these role UUIDs as historical data.
--
-- This migration does not change permissions JSON, admin/manager flags,
-- memberships, or user identities.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM organizations.memberships membership
    JOIN organizations.roles role
      ON role.id = membership.role_id
    WHERE membership.status = 'active'
      AND role.role_key IN (
        'activity_coordinator',
        'driver',
        'employee',
        'finance',
        'fleet_coordinator',
        'guest_relations',
        'reservations_agent',
        'tour_guide',
        'tourism_operations_manager'
      )
  ) THEN
    RAISE EXCEPTION
      'ROLE CLEANUP BLOCKED — requires decision: active memberships still reference legacy roles';
  END IF;
END
$$;

UPDATE organizations.roles
SET
  is_active = TRUE,
  updated_at = NOW()
WHERE role_key IN (
  'admin',
  'manager',
  'it',
  'media_team',
  'social_media',
  'seo_specialist'
);

UPDATE organizations.roles
SET
  is_active = FALSE,
  is_default_signup_role = FALSE,
  updated_at = NOW()
WHERE role_key IN (
  'activity_coordinator',
  'driver',
  'employee',
  'finance',
  'fleet_coordinator',
  'guest_relations',
  'reservations_agent',
  'tour_guide',
  'tourism_operations_manager'
);
