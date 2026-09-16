CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS organizations;


CREATE TABLE IF NOT EXISTS identity.users (
    id UUID PRIMARY KEY,
    email TEXT,
    email_normalized TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    account_status TEXT NOT NULL DEFAULT 'pending',

    deleted_at TIMESTAMPTZ,

    legacy_source TEXT,
    legacy_id UUID,

    CONSTRAINT users_account_status_check
        CHECK (
            account_status IN (
                'pending',
                'pending_approval',
                'active',
                'suspended',
                'rejected',
                'deleted'
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_unique
    ON identity.users (email_normalized)
    WHERE email_normalized IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_legacy_source_id_unique
    ON identity.users (legacy_source, legacy_id)
    WHERE legacy_source IS NOT NULL
      AND legacy_id IS NOT NULL;


-- ============================================================
-- USER PROFILES
-- ============================================================

CREATE TABLE IF NOT EXISTS identity.user_profiles (
    user_id UUID PRIMARY KEY
        REFERENCES identity.users(id)
        ON DELETE CASCADE,

    full_name TEXT,
    phone TEXT,
    avatar_url TEXT,
    job_title TEXT,
    department TEXT,
    employee_code TEXT,
    username TEXT,

    office_id UUID,

    primary_role_key TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    email_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,

    last_seen_at TIMESTAMPTZ,

    is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    suspended_at TIMESTAMPTZ,
    suspended_by UUID,
    suspension_reason TEXT,

    leave_days_total INTEGER NOT NULL DEFAULT 22,
    leave_days_remaining INTEGER NOT NULL DEFAULT 22,

    manager_pin_hash TEXT,
    manager_pin_set_at TIMESTAMPTZ,
    manager_pin_last_changed_at TIMESTAMPTZ,

    approved_at TIMESTAMPTZ,
    approved_by UUID,

    rejected_at TIMESTAMPTZ,
    rejected_by UUID,
    rejection_reason TEXT,

    deleted_at TIMESTAMPTZ,
    deleted_by UUID,
    deletion_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    legacy_source TEXT,
    legacy_id UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_username_unique
    ON identity.user_profiles (username)
    WHERE username IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_profiles_employee_code_idx
    ON identity.user_profiles (employee_code);

CREATE INDEX IF NOT EXISTS user_profiles_department_idx
    ON identity.user_profiles (department);



CREATE TABLE IF NOT EXISTS organizations.organizations (
    id UUID PRIMARY KEY,

    name TEXT NOT NULL,
    slug TEXT NOT NULL,

    timezone TEXT NOT NULL DEFAULT 'Africa/Harare',

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    status TEXT NOT NULL DEFAULT 'active',
    access_status TEXT NOT NULL DEFAULT 'active',

    is_system_organization BOOLEAN NOT NULL DEFAULT FALSE,
    is_system_owner BOOLEAN NOT NULL DEFAULT FALSE,

    settings JSONB NOT NULL DEFAULT '{}'::jsonb,

    social_media_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    social_media_settings JSONB NOT NULL DEFAULT '{}'::jsonb,

    leave_settings JSONB NOT NULL DEFAULT '{}'::jsonb,

    logo_url TEXT,
    primary_color TEXT DEFAULT '#000000',
    secondary_color TEXT DEFAULT '#ffffff',

    custom_domain TEXT,
    subdomain TEXT,

    suspended_reason TEXT,
    suspended_at TIMESTAMPTZ,
    suspended_by UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    legacy_source TEXT,
    legacy_id UUID,

    CONSTRAINT organizations_status_check
        CHECK (status IN ('active', 'suspended')),

    CONSTRAINT organizations_access_status_check
        CHECK (
            access_status IN (
                'active',
                'trialing',
                'suspended',
                'cancelled'
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_unique
    ON organizations.organizations (slug);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_custom_domain_unique
    ON organizations.organizations (custom_domain)
    WHERE custom_domain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_subdomain_unique
    ON organizations.organizations (subdomain)
    WHERE subdomain IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_legacy_source_id_unique
    ON organizations.organizations (legacy_source, legacy_id)
    WHERE legacy_source IS NOT NULL
      AND legacy_id IS NOT NULL;



CREATE TABLE IF NOT EXISTS organizations.roles (
    id UUID PRIMARY KEY,

    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,

    role_key TEXT NOT NULL,
    role_label TEXT NOT NULL,

    description TEXT,
    department TEXT,

    is_admin_role BOOLEAN NOT NULL DEFAULT FALSE,
    is_manager_role BOOLEAN NOT NULL DEFAULT FALSE,
    is_default_signup_role BOOLEAN NOT NULL DEFAULT FALSE,
    requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    onboarding_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    department_access JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_by UUID,
    updated_by UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    legacy_source TEXT,
    legacy_id UUID,

    CONSTRAINT organization_roles_unique_key
        UNIQUE (organization_id, role_key)
);

CREATE INDEX IF NOT EXISTS organization_roles_org_idx
    ON organizations.roles (organization_id);

CREATE INDEX IF NOT EXISTS organization_roles_active_idx
    ON organizations.roles (organization_id, is_active);



CREATE TABLE IF NOT EXISTS organizations.memberships (
    id UUID PRIMARY KEY,

    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,

    role_id UUID
        REFERENCES organizations.roles(id)
        ON DELETE SET NULL,

    role_key TEXT,

    status TEXT NOT NULL DEFAULT 'active',

    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    invited_by UUID,
    notes TEXT,

    removed_at TIMESTAMPTZ,
    removed_by UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    legacy_source TEXT,
    legacy_id UUID,

    CONSTRAINT memberships_status_check
        CHECK (
            status IN (
                'active',
                'pending',
                'suspended',
                'removed'
            )
        ),

    CONSTRAINT memberships_org_user_unique
        UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx
    ON organizations.memberships (user_id);

CREATE INDEX IF NOT EXISTS memberships_org_status_idx
    ON organizations.memberships (organization_id, status);

CREATE INDEX IF NOT EXISTS memberships_user_status_idx
    ON organizations.memberships (user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_active_org_per_user
    ON organizations.memberships (user_id)
    WHERE status = 'active';


COMMENT ON TABLE identity.users IS
    'Kode canonical user identity. Legacy Supabase auth.users UUIDs are preserved during migration.';

COMMENT ON TABLE identity.user_profiles IS
    'Kode user profile data migrated from the legacy Supabase profiles table.';

COMMENT ON TABLE organizations.organizations IS
    'Kode canonical organization/tenant records migrated from legacy organizations.';

COMMENT ON TABLE organizations.memberships IS
    'User-to-organization membership and authorization relationship.';

COMMENT ON TABLE organizations.roles IS
    'Organization-scoped roles migrated from legacy organization_roles.';
