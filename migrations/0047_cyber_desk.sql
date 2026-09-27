
CREATE TABLE IF NOT EXISTS security.monitored_systems (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL DEFAULT 'external'
        CHECK (kind IN ('platform', 'product', 'external', 'infrastructure')),
    environment TEXT NOT NULL DEFAULT 'production'
        CHECK (environment IN ('development', 'staging', 'production')),
    base_url TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'retired')),
    health_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'critical', 'offline')),
    last_heartbeat_at TIMESTAMPTZ,
    last_event_at TIMESTAMPTZ,
    open_alert_count INT NOT NULL DEFAULT 0 CHECK (open_alert_count >= 0),
    open_incident_count INT NOT NULL DEFAULT 0 CHECK (open_incident_count >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_monitored_systems_slug_uq UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS security_monitored_systems_org_idx
    ON security.monitored_systems (organization_id, status);

CREATE TABLE IF NOT EXISTS security.ingest_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    system_id UUID NOT NULL
        REFERENCES security.monitored_systems(id)
        ON DELETE CASCADE,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'default',
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_ingest_tokens_hash_uq UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS security_ingest_tokens_system_idx
    ON security.ingest_tokens (system_id)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS security.detection_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    system_id UUID
        REFERENCES security.monitored_systems(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    event_type_pattern TEXT NOT NULL,
    min_severity TEXT NOT NULL DEFAULT 'medium'
        CHECK (min_severity IN ('info', 'low', 'medium', 'high', 'critical')),
    min_risk_score INT NOT NULL DEFAULT 50 CHECK (min_risk_score >= 0),
    create_alert BOOLEAN NOT NULL DEFAULT TRUE,
    create_incident BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS security_detection_rules_org_idx
    ON security.detection_rules (organization_id)
    WHERE enabled = TRUE;

ALTER TABLE security.events
    ADD COLUMN IF NOT EXISTS system_id UUID
        REFERENCES security.monitored_systems(id)
        ON DELETE SET NULL;

ALTER TABLE security.events
    ADD COLUMN IF NOT EXISTS external_event_id TEXT;

ALTER TABLE security.events
    ADD COLUMN IF NOT EXISTS attack_category TEXT;

CREATE INDEX IF NOT EXISTS security_events_system_created_idx
    ON security.events (system_id, created_at DESC)
    WHERE system_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS security_events_external_id_uq
    ON security.events (organization_id, system_id, external_event_id)
    WHERE external_event_id IS NOT NULL AND system_id IS NOT NULL;

ALTER TABLE security.alerts
    ADD COLUMN IF NOT EXISTS system_id UUID
        REFERENCES security.monitored_systems(id)
        ON DELETE SET NULL;

ALTER TABLE security.alerts
    ADD COLUMN IF NOT EXISTS attack_category TEXT;

CREATE INDEX IF NOT EXISTS security_alerts_system_idx
    ON security.alerts (system_id, status)
    WHERE system_id IS NOT NULL;

ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS system_id UUID
        REFERENCES security.monitored_systems(id)
        ON DELETE SET NULL;

ALTER TABLE security.incidents
    ADD COLUMN IF NOT EXISTS attack_category TEXT;

INSERT INTO security.monitored_systems (
    organization_id, slug, name, description, kind, environment, base_url, status, health_status, metadata
)
SELECT
    o.id,
    v.slug,
    v.name,
    v.description,
    v.kind,
    'production',
    v.base_url,
    'active',
    'unknown',
    v.metadata::jsonb
FROM organizations.organizations o
CROSS JOIN (
    VALUES
        (
            'kode-platform',
            'Kode Platform',
            'Primary Codex / Kode API + workspace (this system). Auth, sessions, and platform attack surface.',
            'platform',
            'https://api.tmctechsolutions.com',
            '{"role":"self","monitors":["auth","api","sessions","blocklist"]}'
        ),
        (
            'harold',
            'Harold',
            'Harold product — nested under the IT cyber desk for attack signals, flagged issues, and health.',
            'product',
            NULL,
            '{"role":"nested","owner_team":"it"}'
        ),
        (
            'itsnomatata-media',
            'IT''s No Matata Media',
            'Media / Content Studio stack — nested under the cyber desk for abuse, access, and delivery risks.',
            'product',
            NULL,
            '{"role":"nested","owner_team":"media"}'
        )
) AS v(slug, name, description, kind, base_url, metadata)
WHERE lower(o.name) LIKE '%no matata%'
ON CONFLICT (organization_id, slug) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    kind = EXCLUDED.kind,
    base_url = COALESCE(EXCLUDED.base_url, security.monitored_systems.base_url),
    metadata = security.monitored_systems.metadata || EXCLUDED.metadata,
    updated_at = NOW();

-- Default detection rules (org-wide + per nested system).
INSERT INTO security.detection_rules (
    organization_id, system_id, name, description, event_type_pattern,
    min_severity, min_risk_score, create_alert, create_incident, enabled
)
SELECT
    s.organization_id,
    s.id,
    r.name,
    r.description,
    r.event_type_pattern,
    r.min_severity,
    r.min_risk_score,
    r.create_alert,
    r.create_incident,
    TRUE
FROM security.monitored_systems s
CROSS JOIN (
    VALUES
        (
            'Critical attack signal',
            'Any critical-severity event from this system opens an alert and incident.',
            '%',
            'critical',
            80,
            TRUE,
            TRUE
        ),
        (
            'High-severity flagged issue',
            'High-severity or high risk_score events create an open alert for the desk.',
            '%',
            'high',
            70,
            TRUE,
            FALSE
        ),
        (
            'Auth abuse / brute force',
            'Failed logins, credential stuffing, and access denials.',
            '%login%|%auth%|%credential%|%access_denied%',
            'medium',
            40,
            TRUE,
            FALSE
        ),
        (
            'Injection / malware / exploit patterns',
            'SQLi, XSS, prompt injection, malware, and exploit attempts.',
            '%injection%|%xss%|%sqli%|%malware%|%exploit%|%ransomware%|%c2%',
            'high',
            60,
            TRUE,
            TRUE
        )
) AS r(name, description, event_type_pattern, min_severity, min_risk_score, create_alert, create_incident)
WHERE NOT EXISTS (
    SELECT 1
    FROM security.detection_rules d
    WHERE d.organization_id = s.organization_id
      AND d.system_id = s.id
      AND d.name = r.name
);
