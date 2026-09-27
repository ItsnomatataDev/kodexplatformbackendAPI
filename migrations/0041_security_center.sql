CREATE SCHEMA IF NOT EXISTS security;

CREATE TABLE IF NOT EXISTS security.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    auth_session_id UUID,
    ip_address TEXT,
    country TEXT,
    city TEXT,
    user_agent TEXT,
    browser TEXT,
    os TEXT,
    device TEXT,
    risk_score INT NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
    reauthentication_required BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    precise_latitude NUMERIC(10, 7),
    precise_longitude NUMERIC(10, 7),
    location_accuracy_meters NUMERIC(12, 2),
    location_permission_granted BOOLEAN,
    location_captured_at TIMESTAMPTZ,
    location_source TEXT NOT NULL DEFAULT 'ip',
    device_fingerprint TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS security.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    fingerprint_hash TEXT NOT NULL,
    user_agent TEXT,
    browser TEXT,
    os TEXT,
    device TEXT,
    first_ip_address TEXT,
    last_ip_address TEXT,
    country TEXT,
    city TEXT,
    trusted BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT security_devices_uq UNIQUE (organization_id, user_id, fingerprint_hash)
);

CREATE TABLE IF NOT EXISTS security.ip_reputation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    ip_address TEXT NOT NULL,
    country TEXT,
    city TEXT,
    region TEXT,
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    timezone TEXT,
    isp TEXT,
    asn TEXT,
    enriched_at TIMESTAMPTZ,
    risk_score INT NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
    total_events INT NOT NULL DEFAULT 0 CHECK (total_events >= 0),
    failed_logins INT NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
    last_event_type TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT security_ip_reputation_uq UNIQUE (organization_id, ip_address)
);

CREATE TABLE IF NOT EXISTS security.blocklist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    target_type TEXT NOT NULL DEFAULT 'ip'
        CHECK (target_type IN ('ip', 'email')),
    target_value TEXT NOT NULL,
    reason TEXT NOT NULL,
    blocked_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    unblocked_at TIMESTAMPTZ,
    unblocked_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS security_blocklist_active_target_idx
    ON security.blocklist (organization_id, target_type, lower(target_value))
    WHERE unblocked_at IS NULL;

CREATE TABLE IF NOT EXISTS security.events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    session_id UUID
        REFERENCES security.sessions(id)
        ON DELETE SET NULL,
    ip_address TEXT,
    country TEXT,
    city TEXT,
    region TEXT,
    latitude NUMERIC(10, 7),
    longitude NUMERIC(10, 7),
    timezone TEXT,
    isp TEXT,
    asn TEXT,
    enriched_at TIMESTAMPTZ,
    user_agent TEXT,
    browser TEXT,
    os TEXT,
    device TEXT,
    request_method TEXT,
    endpoint TEXT,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'low'
        CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    risk_score INT NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
    successful BOOLEAN NOT NULL DEFAULT FALSE,
    precise_latitude NUMERIC(10, 7),
    precise_longitude NUMERIC(10, 7),
    location_accuracy_meters NUMERIC(12, 2),
    location_permission_granted BOOLEAN,
    location_captured_at TIMESTAMPTZ,
    location_source TEXT NOT NULL DEFAULT 'ip',
    device_fingerprint TEXT,
    platform TEXT,
    screen_width INT,
    screen_height INT,
    language TEXT,
    hardware_concurrency INT,
    device_memory NUMERIC(8, 2),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_events_org_created_idx
    ON security.events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security.alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    event_id UUID
        REFERENCES security.events(id)
        ON DELETE SET NULL,
    user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    ip_address TEXT,
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    resolved_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security.incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'investigating', 'resolved')),
    related_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    related_ip_address TEXT,
    event_ids UUID[] NOT NULL DEFAULT '{}',
    admin_notes TEXT,
    assigned_to UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    resolved_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security.login_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending_location'
        CHECK (status IN (
            'pending_location',
            'pending_email_otp',
            'manual_review',
            'approved',
            'rejected',
            'expired'
        )),
    risk_score INT NOT NULL DEFAULT 0,
    risk_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
    ip_address TEXT,
    approximate_country TEXT,
    approximate_city TEXT,
    approximate_latitude NUMERIC(10, 7),
    approximate_longitude NUMERIC(10, 7),
    browser TEXT,
    os TEXT,
    device TEXT,
    location_permission_granted BOOLEAN NOT NULL DEFAULT FALSE,
    location_accuracy_meters NUMERIC(12, 2),
    location_source TEXT NOT NULL DEFAULT 'ip',
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
