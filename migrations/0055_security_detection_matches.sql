-- Durable detection matches. Rules stay in application code.
-- Existing security.detection_rules continue to drive alerts and are not reused here.

CREATE TABLE IF NOT EXISTS security.detection_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE RESTRICT,
    project_id UUID,
    integration_id UUID,
    rule_id TEXT NOT NULL,
    trigger_event_id UUID NOT NULL
        REFERENCES security.events(id)
        ON DELETE RESTRICT,
    severity TEXT NOT NULL
        CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    confidence NUMERIC(4, 3) NOT NULL
        CHECK (confidence >= 0 AND confidence <= 1),
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_detection_matches_rule_window_uq
        UNIQUE (organization_id, rule_id, trigger_event_id),
    CONSTRAINT security_detection_matches_project_org_fk
        FOREIGN KEY (project_id, organization_id)
        REFERENCES security.projects (id, organization_id)
        ON DELETE RESTRICT,
    CONSTRAINT security_detection_matches_integration_org_fk
        FOREIGN KEY (integration_id, organization_id)
        REFERENCES security.integrations (id, organization_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS security_detection_matches_org_created_idx
    ON security.detection_matches (organization_id, created_at DESC);
