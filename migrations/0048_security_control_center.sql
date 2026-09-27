-- Security Control Center Phase 1 foundation (additive).
-- Extends security.* without replacing 0041/0047.

-- ---------------------------------------------------------------------------
-- Protected projects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'retired')),
    criticality TEXT NOT NULL DEFAULT 'medium'
        CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    owner_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_projects_slug_uq UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS security_projects_org_idx
    ON security.projects (organization_id, status);

-- ---------------------------------------------------------------------------
-- Asset inventory (not stock.assets)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security.assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    project_id UUID
        REFERENCES security.projects(id)
        ON DELETE SET NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    asset_type TEXT NOT NULL DEFAULT 'service'
        CHECK (asset_type IN (
            'application', 'api', 'server', 'database', 'container',
            'service', 'domain', 'project', 'repository', 'dependency', 'other'
        )),
    environment TEXT NOT NULL DEFAULT 'production'
        CHECK (environment IN ('development', 'staging', 'production')),
    hostname TEXT,
    criticality TEXT NOT NULL DEFAULT 'medium'
        CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'quarantined', 'retired')),
    owner_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_assets_slug_uq UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS security_assets_org_idx
    ON security.assets (organization_id, status);
CREATE INDEX IF NOT EXISTS security_assets_project_idx
    ON security.assets (project_id)
    WHERE project_id IS NOT NULL;

-- Link monitored systems to projects
ALTER TABLE security.monitored_systems
    ADD COLUMN IF NOT EXISTS project_id UUID
        REFERENCES security.projects(id)
        ON DELETE SET NULL;

-- Event enrichment columns
ALTER TABLE security.events
    ADD COLUMN IF NOT EXISTS project_id UUID
        REFERENCES security.projects(id)
        ON DELETE SET NULL;
ALTER TABLE security.events
    ADD COLUMN IF NOT EXISTS asset_id UUID
        REFERENCES security.assets(id)
        ON DELETE SET NULL;
ALTER TABLE security.events
    ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE security.events
    ADD COLUMN IF NOT EXISTS http_status INT;

CREATE INDEX IF NOT EXISTS security_events_ip_created_idx
    ON security.events (organization_id, ip_address, created_at DESC)
    WHERE ip_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS security_events_type_created_idx
    ON security.events (organization_id, event_type, created_at DESC);

-- ---------------------------------------------------------------------------
-- Incident ↔ event timeline
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security.incident_events (
    incident_id UUID NOT NULL
        REFERENCES security.incidents(id)
        ON DELETE CASCADE,
    event_id UUID NOT NULL
        REFERENCES security.events(id)
        ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    linked_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    PRIMARY KEY (incident_id, event_id)
);

CREATE INDEX IF NOT EXISTS security_incident_events_event_idx
    ON security.incident_events (event_id);

-- Expand incident statuses (drop old check, add new)
ALTER TABLE security.incidents
    DROP CONSTRAINT IF EXISTS security_incidents_status_check;
ALTER TABLE security.incidents
    ADD CONSTRAINT security_incidents_status_check
    CHECK (status IN (
        'open', 'investigating', 'contained', 'resolved', 'false_positive'
    ));

ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS asset_id UUID
        REFERENCES security.assets(id)
        ON DELETE SET NULL;
ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS project_id UUID
        REFERENCES security.projects(id)
        ON DELETE SET NULL;
ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS containment_notes TEXT;
ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS public_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS security_incidents_public_id_uq
    ON security.incidents (organization_id, public_id)
    WHERE public_id IS NOT NULL;

-- Expand alert statuses
ALTER TABLE security.alerts
    DROP CONSTRAINT IF EXISTS security_alerts_status_check;
ALTER TABLE security.alerts
    ADD CONSTRAINT security_alerts_status_check
    CHECK (status IN (
        'open', 'new', 'acknowledged', 'investigating', 'resolved', 'dismissed'
    ));

ALTER TABLE security.alerts
    ADD COLUMN IF NOT EXISTS rule_id UUID
        REFERENCES security.detection_rules(id)
        ON DELETE SET NULL;
ALTER TABLE security.alerts
    ADD COLUMN IF NOT EXISTS incident_id UUID
        REFERENCES security.incidents(id)
        ON DELETE SET NULL;
ALTER TABLE security.alerts
    ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE security.alerts
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE security.alerts
    ADD COLUMN IF NOT EXISTS event_count INT NOT NULL DEFAULT 1 CHECK (event_count >= 0);

-- ---------------------------------------------------------------------------
-- Append-only audit log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    actor_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    previous_state JSONB,
    resulting_state JSONB,
    reason TEXT,
    request_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No UPDATE/DELETE grants for application role is enforced at app layer;
-- table is insert-oriented. Index for investigators.
CREATE INDEX IF NOT EXISTS security_audit_log_org_created_idx
    ON security.audit_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_log_action_idx
    ON security.audit_log (organization_id, action, created_at DESC);

-- ---------------------------------------------------------------------------
-- Honeypots (authorized decoys only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security.honeypots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    project_id UUID
        REFERENCES security.projects(id)
        ON DELETE SET NULL,
    asset_id UUID
        REFERENCES security.assets(id)
        ON DELETE SET NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    endpoint_path TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    severity TEXT NOT NULL DEFAULT 'high'
        CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    response_status INT NOT NULL DEFAULT 404,
    response_body TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_honeypots_slug_uq UNIQUE (organization_id, slug),
    CONSTRAINT security_honeypots_path_uq UNIQUE (organization_id, endpoint_path)
);

CREATE INDEX IF NOT EXISTS security_honeypots_org_enabled_idx
    ON security.honeypots (organization_id)
    WHERE enabled = TRUE;

-- ---------------------------------------------------------------------------
-- Containment actions (explicit + auditable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security.containment_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    action_type TEXT NOT NULL
        CHECK (action_type IN (
            'block_ip', 'unblock_ip', 'revoke_session', 'revoke_credential',
            'disable_api_key', 'quarantine_asset', 'increase_rate_limit',
            'require_step_up', 'other'
        )),
    target_type TEXT NOT NULL,
    target_value TEXT NOT NULL,
    reason TEXT NOT NULL,
    performed_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    incident_id UUID
        REFERENCES security.incidents(id)
        ON DELETE SET NULL,
    previous_state JSONB,
    resulting_state JSONB,
    automatic BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_containment_org_created_idx
    ON security.containment_actions (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Seed default Kode project + map existing monitored systems
-- ---------------------------------------------------------------------------
INSERT INTO security.projects (
    organization_id, slug, name, description, criticality, metadata
)
SELECT
    o.id,
    'kode-platform',
    'Kode Platform',
    'Default protected project for the Kode API and enrolled workspace products.',
    'critical',
    jsonb_build_object('seeded', true)
FROM organizations.organizations o
WHERE o.is_active = TRUE
  AND NOT EXISTS (
      SELECT 1 FROM security.projects p
      WHERE p.organization_id = o.id AND p.slug = 'kode-platform'
  );

UPDATE security.monitored_systems ms
SET project_id = p.id,
    updated_at = NOW()
FROM security.projects p
WHERE p.organization_id = ms.organization_id
  AND p.slug = 'kode-platform'
  AND ms.project_id IS NULL;

-- Seed assets from monitored systems (idempotent)
INSERT INTO security.assets (
    organization_id, project_id, slug, name, asset_type, environment,
    hostname, criticality, status, metadata
)
SELECT
    ms.organization_id,
    ms.project_id,
    ms.slug,
    ms.name,
    CASE ms.kind
        WHEN 'platform' THEN 'api'
        WHEN 'product' THEN 'application'
        WHEN 'infrastructure' THEN 'server'
        ELSE 'service'
    END,
    ms.environment,
    ms.base_url,
    'high',
    CASE WHEN ms.status = 'retired' THEN 'retired' ELSE 'active' END,
    jsonb_build_object('seeded_from', 'monitored_systems', 'system_id', ms.id)
FROM security.monitored_systems ms
WHERE NOT EXISTS (
    SELECT 1 FROM security.assets a
    WHERE a.organization_id = ms.organization_id AND a.slug = ms.slug
);

-- ---------------------------------------------------------------------------
-- Permissions (least privilege beyond admin wildcard)
-- ---------------------------------------------------------------------------
UPDATE organizations.roles
SET
  permissions = COALESCE(permissions, '{}'::jsonb) || '{
    "security": {
      "view": true,
      "investigate": true,
      "manage_assets": true,
      "manage_rules": true,
      "manage_honeypots": true,
      "contain": true,
      "manage_configuration": true,
      "audit": true,
      "manage": true
    }
  }'::jsonb,
  updated_at = NOW()
WHERE role_key IN ('admin', 'it')
  AND is_active = TRUE;

-- Default decoy honeypot path for enrolled orgs (disabled until explicitly enabled)
INSERT INTO security.honeypots (
    organization_id, project_id, slug, name, endpoint_path, enabled, severity
)
SELECT
    p.organization_id,
    p.id,
    'admin-security-test',
    'Admin security test decoy',
    '/admin/security-test',
    FALSE,
    'high'
FROM security.projects p
WHERE p.slug = 'kode-platform'
  AND NOT EXISTS (
      SELECT 1 FROM security.honeypots h
      WHERE h.organization_id = p.organization_id
        AND h.slug = 'admin-security-test'
  );
