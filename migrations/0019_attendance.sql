CREATE SCHEMA IF NOT EXISTS attendance;

CREATE TABLE IF NOT EXISTS attendance.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    clock_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    clock_out_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active',
    work_seconds INTEGER NOT NULL DEFAULT 0,
    clock_in_method TEXT NOT NULL DEFAULT 'web',
    clock_out_method TEXT,
    notes TEXT,
    ip_address TEXT,
    device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
    location JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT attendance_sessions_status_check
        CHECK (status IN ('active', 'completed', 'missed_clock_out')),
    CONSTRAINT attendance_sessions_work_seconds_check
        CHECK (work_seconds >= 0),
    CONSTRAINT attendance_sessions_clock_order_check
        CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_one_active_per_user_idx
    ON attendance.sessions (user_id)
    WHERE status = 'active' AND clock_out_at IS NULL;

CREATE INDEX IF NOT EXISTS attendance_sessions_org_clock_in_idx
    ON attendance.sessions (organization_id, clock_in_at DESC);

CREATE INDEX IF NOT EXISTS attendance_sessions_org_user_clock_in_idx
    ON attendance.sessions (organization_id, user_id, clock_in_at DESC);

CREATE INDEX IF NOT EXISTS attendance_sessions_org_office_clock_in_idx
    ON attendance.sessions (organization_id, office_id, clock_in_at DESC)
    WHERE office_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS attendance.daily_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    attendance_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'present',
    expected_clock_in_at TIMESTAMPTZ,
    actual_clock_in_at TIMESTAMPTZ,
    session_id UUID
        REFERENCES attendance.sessions(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT attendance_daily_status_check
        CHECK (status IN ('present', 'late', 'absent', 'on_leave', 'pending')),
    CONSTRAINT attendance_daily_status_org_user_date_unique
        UNIQUE (organization_id, user_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS attendance_daily_status_org_date_idx
    ON attendance.daily_status (organization_id, attendance_date);

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{attendance}',
    COALESCE(permissions->'attendance', '{}'::jsonb) || '{
      "read": true,
      "clock": true
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
    '{attendance}',
    COALESCE(permissions->'attendance', '{}'::jsonb) || '{
      "manage": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN (
  'admin',
  'manager',
  'it'
)
AND is_active = TRUE;
