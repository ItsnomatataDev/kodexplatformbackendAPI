CREATE SCHEMA IF NOT EXISTS leave;

CREATE TABLE IF NOT EXISTS leave.types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    default_days INT NOT NULL DEFAULT 0,
    is_paid BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT leave_types_org_name_uq UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS leave.requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    leave_type_id UUID
        REFERENCES leave.types(id)
        ON DELETE SET NULL,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    requested_days INT NOT NULL DEFAULT 1,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    approved_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    request_department TEXT,
    request_role TEXT,
    office TEXT,
    balance_deducted_at TIMESTAMPTZ,
    admin_notes TEXT,
    edited_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    edited_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancelled_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    cancellation_reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT leave_requests_dates_valid CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS leave_requests_org_user_idx
    ON leave.requests (organization_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS leave_requests_org_status_idx
    ON leave.requests (organization_id, status, start_date);

CREATE TABLE IF NOT EXISTS leave.calendar_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    rule_type TEXT NOT NULL
        CHECK (rule_type IN ('open', 'closed')),
    applies_to_role TEXT,
    applies_to_department TEXT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leave_calendar_rules_org_dates_idx
    ON leave.calendar_rules (organization_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS leave.public_holidays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    holiday_date DATE NOT NULL,
    title TEXT NOT NULL,
    country_code TEXT NOT NULL DEFAULT 'ZW',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT leave_public_holidays_org_date_uq
        UNIQUE (organization_id, country_code, holiday_date)
);

CREATE TABLE IF NOT EXISTS leave.balance_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    actor_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    previous_total INT,
    previous_remaining INT,
    new_total INT,
    new_remaining INT,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leave_balance_audit_org_user_idx
    ON leave.balance_audit (organization_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS leave.request_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    leave_request_id UUID NOT NULL
        REFERENCES leave.requests(id)
        ON DELETE CASCADE,
    actor_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    action TEXT NOT NULL,
    previous_data JSONB,
    new_data JSONB,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{leave}',
    COALESCE(permissions->'leave', '{}'::jsonb) || '{
      "read": true,
      "request": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE is_active = TRUE;

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{leave}',
    COALESCE(permissions->'leave', '{}'::jsonb) || '{
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
