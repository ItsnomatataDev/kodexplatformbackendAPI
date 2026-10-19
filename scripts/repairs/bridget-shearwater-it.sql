\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  target uuid := 'cd184604-a015-466d-a409-773be98db0ae';
  org uuid := 'ae975c01-c044-4c5d-b5b5-4b6a06b55957';
  office uuid := 'f28c4775-ba45-4f6e-97f6-14b7c9758d94';
  role uuid := '95e2d8df-4afb-4ff1-8ffb-d4c4250e4dcc';
BEGIN
  PERFORM 1 FROM identity.users u JOIN identity.user_profiles p ON p.user_id=u.id
    WHERE u.id=target AND p.full_name='Bridget N'
      AND u.account_status IN ('pending','pending_approval','active')
      AND u.is_active AND u.deleted_at IS NULL
      AND p.deleted_at IS NULL AND NOT COALESCE(p.is_suspended,FALSE)
    FOR UPDATE OF u,p;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bridget identity/status changed; repair stopped'; END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations.roles r
    JOIN organizations.offices o ON o.organization_id=r.organization_id
    WHERE r.id=role AND r.organization_id=org AND r.role_key='it'
      AND r.is_active AND o.id=office AND o.is_active) THEN
    RAISE EXCEPTION 'Expected active Shearwater office and IT role not found';
  END IF;
  IF EXISTS (SELECT 1 FROM organizations.memberships WHERE user_id=target
    AND (organization_id<>org OR status NOT IN ('pending','active')
      OR (role_id IS NOT NULL AND role_id<>role)
      OR (office_id IS NOT NULL AND office_id<>office))) THEN
    RAISE EXCEPTION 'Unexpected existing membership; repair stopped';
  END IF;
  INSERT INTO organizations.memberships
    (id,organization_id,user_id,role_id,role_key,status,office_id,notes)
  VALUES (gen_random_uuid(),org,target,role,'it','active',office,
    'Shearwater IT access repair, confirmed by operator on 2026-10-10')
  ON CONFLICT (organization_id,user_id) DO UPDATE SET
    role_id=EXCLUDED.role_id, role_key='it', status='active',
    office_id=EXCLUDED.office_id, updated_at=NOW();
  UPDATE identity.users SET account_status='active',updated_at=NOW() WHERE id=target;
  UPDATE identity.user_profiles SET primary_role_key='it',office_id=office,
    approved_at=COALESCE(approved_at,NOW()),updated_at=NOW() WHERE user_id=target;
END $$;
SELECT p.full_name,u.account_status,m.status AS membership_status,m.role_key,o.name AS office
FROM identity.users u JOIN identity.user_profiles p ON p.user_id=u.id
JOIN organizations.memberships m ON m.user_id=u.id
JOIN organizations.offices o ON o.id=m.office_id
WHERE u.id='cd184604-a015-466d-a409-773be98db0ae';
COMMIT;
