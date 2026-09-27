CREATE SCHEMA IF NOT EXISTS tourism;

CREATE TABLE IF NOT EXISTS tourism.guests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    nationality TEXT,
    guest_count INT NOT NULL DEFAULT 1 CHECK (guest_count > 0),
    preferences TEXT,
    special_requests TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'vip', 'watchlist', 'archived')),
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tourism_guests_org_created_idx
    ON tourism.guests (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tourism.bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    guest_id UUID
        REFERENCES tourism.guests(id)
        ON DELETE SET NULL,
    booking_reference TEXT,
    activity_name TEXT NOT NULL,
    booking_date DATE NOT NULL,
    pickup_time TIME,
    pickup_location TEXT,
    guest_count INT NOT NULL DEFAULT 1 CHECK (guest_count > 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
    payment_status TEXT NOT NULL DEFAULT 'unpaid'
        CHECK (payment_status IN ('unpaid', 'deposit_paid', 'paid', 'refunded')),
    notes TEXT,
    assigned_guide_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tourism_bookings_org_date_idx
    ON tourism.bookings (organization_id, booking_date DESC);

CREATE TABLE IF NOT EXISTS tourism.itinerary_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    booking_id UUID
        REFERENCES tourism.bookings(id)
        ON DELETE CASCADE,
    guest_id UUID
        REFERENCES tourism.guests(id)
        ON DELETE SET NULL,
    title TEXT NOT NULL,
    item_type TEXT NOT NULL DEFAULT 'activity'
        CHECK (item_type IN ('arrival', 'transfer', 'activity', 'meal', 'accommodation', 'departure', 'note')),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'confirmed', 'in_progress', 'done', 'cancelled')),
    notes TEXT,
    assigned_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tourism.transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    booking_id UUID
        REFERENCES tourism.bookings(id)
        ON DELETE SET NULL,
    guest_id UUID
        REFERENCES tourism.guests(id)
        ON DELETE SET NULL,
    transfer_type TEXT NOT NULL DEFAULT 'pickup'
        CHECK (transfer_type IN ('pickup', 'dropoff', 'activity_transfer', 'airport', 'border', 'custom')),
    pickup_location TEXT NOT NULL,
    dropoff_location TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'dispatched', 'picked_up', 'completed', 'cancelled')),
    driver_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    vehicle_id UUID
        REFERENCES fleet.vehicles(id)
        ON DELETE SET NULL,
    notes TEXT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tourism_transfers_org_scheduled_idx
    ON tourism.transfers (organization_id, scheduled_at DESC);
