ALTER TABLE security.projects
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'production';

ALTER TABLE security.projects
    DROP CONSTRAINT IF EXISTS security_projects_environment_check;

ALTER TABLE security.projects
    ADD CONSTRAINT security_projects_environment_check
    CHECK (environment IN ('development', 'staging', 'production'));


ALTER TABLE security.projects
    DROP CONSTRAINT IF EXISTS security_projects_id_org_uq;

ALTER TABLE security.projects
    ADD CONSTRAINT security_projects_id_org_uq UNIQUE (id, organization_id);

ALTER TABLE security.assets
    DROP CONSTRAINT IF EXISTS security_assets_project_org_fk;

ALTER TABLE security.assets
    ADD CONSTRAINT security_assets_project_org_fk
    FOREIGN KEY (project_id, organization_id)
    REFERENCES security.projects (id, organization_id)
    ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS security.integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    project_id UUID NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    integration_type TEXT NOT NULL
        CHECK (integration_type IN ('api', 'webhook', 'agent', 'provider')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'revoked')),
    credential_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_integrations_slug_uq UNIQUE (organization_id, slug),
    CONSTRAINT security_integrations_project_org_fk
        FOREIGN KEY (project_id, organization_id)
        REFERENCES security.projects (id, organization_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS security_integrations_project_idx
    ON security.integrations (organization_id, project_id);
