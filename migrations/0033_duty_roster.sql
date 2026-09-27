-- Duty roster tables (Supabase duty_rosters / definitions / entries cutover).

CREATE SCHEMA IF NOT EXISTS duty;

CREATE TABLE IF NOT EXISTS duty.rosters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    title TEXT NOT NULL,
    department TEXT,
    week_start DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'archived')),
    rotation_seed INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    archived_at TIMESTAMPTZ,
    archived_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS duty_rosters_org_office_week_idx
    ON duty.rosters (organization_id, office_id, week_start DESC);

CREATE INDEX IF NOT EXISTS duty_rosters_org_status_idx
    ON duty.rosters (organization_id, status, week_start DESC);

CREATE TABLE IF NOT EXISTS duty.definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    duty_type TEXT NOT NULL DEFAULT 'weekly_rotating'
        CHECK (duty_type IN ('weekly_rotating', 'single_day')),
    category TEXT NOT NULL DEFAULT 'normal_rotation'
        CHECK (category IN (
            'normal_rotation',
            'fixed_person',
            'friday_rotation',
            'custom_rotation'
        )),
    frequency TEXT NOT NULL DEFAULT 'weekly',
    day_of_week INTEGER
        CHECK (day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    allow_managers BOOLEAN NOT NULL DEFAULT TRUE,
    allow_bosses BOOLEAN NOT NULL DEFAULT TRUE,
    fixed_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    fixed_starts_at DATE,
    fixed_ends_at DATE,
    fixed_duty_participates_in_friday_rotation BOOLEAN NOT NULL DEFAULT TRUE,
    included_roles TEXT[] NOT NULL DEFAULT '{}',
    excluded_roles TEXT[] NOT NULL DEFAULT '{}',
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS duty_definitions_org_office_idx
    ON duty.definitions (organization_id, office_id, is_active);

CREATE TABLE IF NOT EXISTS duty.roster_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    roster_id UUID NOT NULL
        REFERENCES duty.rosters(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    shift_date DATE NOT NULL,
    shift_name TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS duty_roster_entries_roster_date_idx
    ON duty.roster_entries (roster_id, shift_date);

CREATE TABLE IF NOT EXISTS duty.roster_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    roster_id UUID NOT NULL
        REFERENCES duty.rosters(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (roster_id, user_id)
);

CREATE INDEX IF NOT EXISTS duty_roster_members_roster_idx
    ON duty.roster_members (roster_id, sort_order);

CREATE TABLE IF NOT EXISTS duty.roster_duties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    roster_id UUID NOT NULL
        REFERENCES duty.rosters(id)
        ON DELETE CASCADE,
    duty_id UUID NOT NULL
        REFERENCES duty.definitions(id)
        ON DELETE CASCADE,
    rotation_offset INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    assigned_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (roster_id, duty_id)
);

CREATE INDEX IF NOT EXISTS duty_roster_duties_roster_idx
    ON duty.roster_duties (roster_id, sort_order);

CREATE TABLE IF NOT EXISTS duty.eligibility_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    duty_id UUID NOT NULL
        REFERENCES duty.definitions(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    is_excluded BOOLEAN NOT NULL DEFAULT FALSE,
    is_forced_included BOOLEAN NOT NULL DEFAULT FALSE,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (duty_id, user_id),
    CONSTRAINT duty_eligibility_override_mode_check
        CHECK (NOT (is_excluded AND is_forced_included))
);

CREATE INDEX IF NOT EXISTS duty_eligibility_overrides_duty_idx
    ON duty.eligibility_overrides (duty_id);

CREATE TABLE IF NOT EXISTS duty.assignment_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    roster_id UUID NOT NULL
        REFERENCES duty.rosters(id)
        ON DELETE CASCADE,
    duty_id UUID NOT NULL
        REFERENCES duty.definitions(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    assignment_week DATE NOT NULL,
    assignment_date DATE,
    source TEXT NOT NULL DEFAULT 'generated'
        CHECK (source IN ('generated', 'manual', 'fixed', 'regenerated')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (roster_id, duty_id, assignment_week)
);

CREATE INDEX IF NOT EXISTS duty_assignment_history_roster_week_idx
    ON duty.assignment_history (roster_id, assignment_week DESC);

CREATE INDEX IF NOT EXISTS duty_assignment_history_duty_week_idx
    ON duty.assignment_history (duty_id, assignment_week DESC);

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{duty_roster}',
    COALESCE(permissions->'duty_roster', '{}'::jsonb) || '{
      "read": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE is_active = TRUE;

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{duty_roster}',
    COALESCE(permissions->'duty_roster', '{}'::jsonb) || '{
      "manage": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN ('admin', 'manager', 'it')
  AND is_active = TRUE;
