CREATE SCHEMA IF NOT EXISTS it;

CREATE TABLE IF NOT EXISTS it.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    due_date DATE,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS it_projects_org_idx
    ON it.projects (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS it.project_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    project_id UUID NOT NULL
        REFERENCES it.projects(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'manager', 'member', 'viewer')),
    invited_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT it_project_members_uq UNIQUE (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS it_project_members_user_idx
    ON it.project_members (user_id, project_id);

CREATE TABLE IF NOT EXISTS it.project_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    project_id UUID NOT NULL
        REFERENCES it.projects(id)
        ON DELETE CASCADE,
    user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    action TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS it_project_activity_project_idx
    ON it.project_activity (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS it.issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    project_id UUID
        REFERENCES it.projects(id)
        ON DELETE SET NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    severity TEXT NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    assignee_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS it_issues_org_idx
    ON it.issues (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS it_issues_open_idx
    ON it.issues (organization_id, status)
    WHERE status IN ('open', 'in_progress');

CREATE TABLE IF NOT EXISTS it.system_monitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    monitor_type TEXT NOT NULL DEFAULT 'service',
    status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('healthy', 'degraded', 'down', 'unknown')),
    last_check_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS it_system_monitors_org_name_uq
    ON it.system_monitors (organization_id, name);

CREATE INDEX IF NOT EXISTS it_system_monitors_org_idx
    ON it.system_monitors (organization_id, name);

CREATE TABLE IF NOT EXISTS it.system_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acknowledged', 'resolved')),
    description TEXT,
    module TEXT,
    message TEXT,
    related_entity_type TEXT,
    related_entity_id UUID,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS it_system_alerts_org_idx
    ON it.system_alerts (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS it.system_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    message TEXT,
    severity TEXT NOT NULL DEFAULT 'info'
        CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    title TEXT,
    description TEXT,
    module TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS it_system_events_org_idx
    ON it.system_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS it.account_access_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    company TEXT,
    requested_role TEXT,
    message TEXT,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS it_account_access_requests_org_idx
    ON it.account_access_requests (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS it_account_access_requests_pending_idx
    ON it.account_access_requests (status, created_at DESC)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS it.incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'investigating', 'resolved')),
    description TEXT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    assigned_to UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS it_incidents_org_idx
    ON it.incidents (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS it.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    actor_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    target_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    action TEXT NOT NULL,
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS it_audit_logs_org_idx
    ON it.audit_logs (organization_id, created_at DESC);
