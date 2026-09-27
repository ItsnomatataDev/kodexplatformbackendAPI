CREATE SCHEMA IF NOT EXISTS location_planner;

CREATE TABLE IF NOT EXISTS location_planner.locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'department'
        CHECK (type IN ('activity_site', 'office', 'department', 'team', 'other')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'closed', 'limited')),
    capacity INT,
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS location_planner.roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    location_id UUID
        REFERENCES location_planner.locations(id)
        ON DELETE SET NULL,
    required_skills TEXT[] NOT NULL DEFAULT '{}',
    is_temporary BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS location_planner.status_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    location_id UUID NOT NULL
        REFERENCES location_planner.locations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('open', 'closed', 'limited')),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    notes TEXT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT location_planner_status_events_date_check CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS location_planner.assignment_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    location_id UUID NOT NULL
        REFERENCES location_planner.locations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    temporary_role_id UUID
        REFERENCES location_planner.roles(id)
        ON DELETE SET NULL,
    required_count INT NOT NULL DEFAULT 1 CHECK (required_count >= 1),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    required_skills TEXT[] NOT NULL DEFAULT '{}',
    priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high')),
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'filled', 'closed')),
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT location_planner_slots_date_check CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS location_planner.employee_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    employee_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    slot_id UUID
        REFERENCES location_planner.assignment_slots(id)
        ON DELETE SET NULL,
    location_id UUID NOT NULL
        REFERENCES location_planner.locations(id)
        ON DELETE CASCADE,
    temporary_role_id UUID
        REFERENCES location_planner.roles(id)
        ON DELETE SET NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'confirmed', 'cancelled')),
    notes TEXT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT location_planner_assignments_date_check CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS location_planner_assignments_org_dates_idx
    ON location_planner.employee_assignments (organization_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS location_planner.employee_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    employee_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    skill TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT location_planner_skills_uq UNIQUE (organization_id, employee_id, skill)
);

CREATE TABLE IF NOT EXISTS location_planner.tlb_off_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    employee_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    off_date DATE NOT NULL,
    reason TEXT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT location_planner_tlb_off_days_uq UNIQUE (organization_id, employee_id, off_date)
);

CREATE TABLE IF NOT EXISTS location_planner.tlb_weekly_off_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    employee_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    reason TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT location_planner_tlb_weekly_uq UNIQUE (organization_id, employee_id, weekday)
);
