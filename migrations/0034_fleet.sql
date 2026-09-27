CREATE SCHEMA IF NOT EXISTS fleet;

CREATE TABLE IF NOT EXISTS fleet.vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    vehicle_name TEXT,
    registration_number TEXT,
    current_odometer_km NUMERIC(12, 2),
    last_service_date DATE,
    last_service_odometer_km NUMERIC(12, 2),
    next_service_date DATE,
    next_service_odometer_km NUMERIC(12, 2),
    service_interval_km NUMERIC(12, 2),
    service_status TEXT,
    estimated_days_to_service NUMERIC(12, 2),
    latest_odometer_at TIMESTAMPTZ,
    last_latitude NUMERIC(10, 7),
    last_longitude NUMERIC(10, 7),
    last_location_at TIMESTAMPTZ,
    last_location_source TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    maintenance_note TEXT,
    maintenance_started_at TIMESTAMPTZ,
    maintenance_started_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    ezitrack_import_paused BOOLEAN NOT NULL DEFAULT FALSE,
    ezitrack_resumed_at TIMESTAMPTZ,
    ezitrack_resumed_import_batch_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fleet_vehicles_org_idx
    ON fleet.vehicles (organization_id, vehicle_name);

CREATE TABLE IF NOT EXISTS fleet.daily_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    vehicle_id UUID NOT NULL
        REFERENCES fleet.vehicles(id)
        ON DELETE CASCADE,
    summary_date DATE NOT NULL,
    source TEXT NOT NULL DEFAULT 'ezitrack_email',
    route_length_km NUMERIC(12, 2) NOT NULL DEFAULT 0,
    move_duration_seconds INT NOT NULL DEFAULT 0,
    stop_duration_seconds INT NOT NULL DEFAULT 0,
    stop_count INT NOT NULL DEFAULT 0,
    top_speed_kmh NUMERIC(10, 2),
    average_speed_kmh NUMERIC(10, 2),
    overspeed_count INT NOT NULL DEFAULT 0,
    fuel_consumption_litres NUMERIC(10, 2),
    average_fuel_consumption_per_100km NUMERIC(10, 2),
    fuel_cost NUMERIC(12, 2),
    currency TEXT NOT NULL DEFAULT 'USD',
    engine_work_seconds INT NOT NULL DEFAULT 0,
    engine_idle_seconds INT NOT NULL DEFAULT 0,
    odometer_km NUMERIC(12, 2),
    engine_hours_seconds INT NOT NULL DEFAULT 0,
    driver_name TEXT,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fleet_daily_summaries_uq UNIQUE (vehicle_id, summary_date, source)
);

CREATE INDEX IF NOT EXISTS fleet_daily_summaries_org_date_idx
    ON fleet.daily_summaries (organization_id, summary_date DESC);

CREATE TABLE IF NOT EXISTS fleet.import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'ezitrack_email',
    import_type TEXT NOT NULL DEFAULT 'daily_report',
    file_name TEXT,
    status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'completed', 'partial_failed', 'failed')),
    total_rows INT NOT NULL DEFAULT 0,
    imported_rows INT NOT NULL DEFAULT 0,
    failed_rows INT NOT NULL DEFAULT 0,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS fleet.import_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    batch_id UUID NOT NULL
        REFERENCES fleet.import_batches(id)
        ON DELETE CASCADE,
    row_number INT NOT NULL,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    mapped_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    vehicle_id UUID
        REFERENCES fleet.vehicles(id)
        ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'imported', 'failed', 'unmatched', 'skipped_maintenance')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet.service_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    vehicle_id UUID NOT NULL
        REFERENCES fleet.vehicles(id)
        ON DELETE CASCADE,
    schedule_name TEXT NOT NULL DEFAULT 'Routine service',
    service_type TEXT NOT NULL DEFAULT 'service',
    interval_km NUMERIC(12, 2),
    interval_months INT,
    last_service_date DATE,
    last_service_odometer_km NUMERIC(12, 2),
    next_service_date DATE,
    next_service_odometer_km NUMERIC(12, 2),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet.maintenance_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    vehicle_id UUID NOT NULL
        REFERENCES fleet.vehicles(id)
        ON DELETE CASCADE,
    service_date DATE NOT NULL,
    odometer_km NUMERIC(12, 2),
    service_type TEXT NOT NULL DEFAULT 'service',
    description TEXT,
    notes TEXT,
    provider TEXT,
    cost NUMERIC(12, 2),
    currency TEXT NOT NULL DEFAULT 'USD',
    receipt_url TEXT,
    invoice_url TEXT,
    next_service_date DATE,
    next_service_odometer_km NUMERIC(12, 2),
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fleet.fuel_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    vehicle_id UUID NOT NULL
        REFERENCES fleet.vehicles(id)
        ON DELETE CASCADE,
    purchase_date TIMESTAMPTZ NOT NULL,
    litres NUMERIC(10, 2) NOT NULL CHECK (litres > 0),
    unit_price NUMERIC(12, 4),
    total_cost NUMERIC(12, 2) NOT NULL CHECK (total_cost >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    odometer_km NUMERIC(12, 2),
    station_name TEXT,
    payment_method TEXT,
    receipt_number TEXT,
    receipt_url TEXT,
    recorded_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fleet_fuel_org_date_idx
    ON fleet.fuel_purchases (organization_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS fleet_maintenance_org_date_idx
    ON fleet.maintenance_records (organization_id, service_date DESC);
