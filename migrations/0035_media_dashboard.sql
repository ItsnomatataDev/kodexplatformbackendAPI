-- Media dashboard: creative requests, deliveries, shoot bookings, fleet vehicles.

CREATE SCHEMA IF NOT EXISTS media;

CREATE TABLE IF NOT EXISTS media.fleet_vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    vehicle_name TEXT,
    registration_number TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS media_fleet_vehicles_org_idx
    ON media.fleet_vehicles (organization_id, vehicle_name);

CREATE TABLE IF NOT EXISTS media.creative_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    request_type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    deadline TIMESTAMPTZ,
    requester_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    assigned_to UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN (
            'requested',
            'planning',
            'shooting',
            'editing',
            'review',
            'approved',
            'delivered',
            'cancelled'
        )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS media_creative_requests_org_status_idx
    ON media.creative_requests (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS media.deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    title TEXT NOT NULL,
    delivery_type TEXT NOT NULL,
    deliverable_format TEXT NOT NULL,
    delivered_to TEXT NOT NULL,
    delivery_date TIMESTAMPTZ,
    file_url TEXT,
    file_object_key TEXT,
    status TEXT NOT NULL DEFAULT 'preparing'
        CHECK (status IN (
            'preparing',
            'delivered',
            'feedback_requested',
            'approved',
            'archived'
        )),
    approval_received BOOLEAN NOT NULL DEFAULT FALSE,
    feedback_notes TEXT,
    created_by UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS media_deliveries_org_status_idx
    ON media.deliveries (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS media.shoot_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    vehicle_id UUID
        REFERENCES media.fleet_vehicles(id)
        ON DELETE RESTRICT,
    vehicle_other TEXT,
    title TEXT NOT NULL,
    client_name TEXT,
    location TEXT NOT NULL,
    notes TEXT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    requested_by UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    reviewed_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT media_shoot_bookings_valid_time CHECK (ends_at > starts_at),
    CONSTRAINT media_shoot_bookings_vehicle_present CHECK (
        vehicle_id IS NOT NULL
        OR nullif(btrim(coalesce(vehicle_other, '')), '') IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS media_shoot_bookings_org_dates_idx
    ON media.shoot_bookings (organization_id, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS media_shoot_bookings_pending_idx
    ON media.shoot_bookings (organization_id, status, created_at DESC);

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  ALTER TABLE media.shoot_bookings
    ADD CONSTRAINT media_shoot_bookings_vehicle_no_overlap
    EXCLUDE USING gist (
      vehicle_id WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    )
    WHERE (status IN ('pending', 'approved') AND vehicle_id IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{media}',
    COALESCE(permissions->'media', '{}'::jsonb) || '{
      "read": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE is_active = TRUE;

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{media}',
    COALESCE(permissions->'media', '{}'::jsonb) || '{
      "manage": true,
      "approve": true
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

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{media}',
    COALESCE(permissions->'media', '{}'::jsonb) || '{
      "approve": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN ('admin', 'manager')
  AND is_active = TRUE;
