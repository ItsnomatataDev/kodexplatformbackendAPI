-- Phase 02B: hashed integration credentials. Raw secrets are not stored.

ALTER TABLE security.integrations
    DROP CONSTRAINT IF EXISTS security_integrations_id_org_uq;

ALTER TABLE security.integrations
    ADD CONSTRAINT security_integrations_id_org_uq UNIQUE (id, organization_id);

CREATE TABLE IF NOT EXISTS security.integration_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    integration_id UUID NOT NULL,
    key_id TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'events:write'
        CHECK (scope = 'events:write'),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_integration_credentials_key_uq UNIQUE (key_id),
    CONSTRAINT security_integration_credentials_integration_org_fk
        FOREIGN KEY (integration_id, organization_id)
        REFERENCES security.integrations (id, organization_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS security_integration_credentials_integration_idx
    ON security.integration_credentials (organization_id, integration_id);
