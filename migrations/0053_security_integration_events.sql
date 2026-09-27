ALTER TABLE security.integration_credentials
    DROP CONSTRAINT IF EXISTS integration_credentials_scope_check;

ALTER TABLE security.integration_credentials
    DROP CONSTRAINT IF EXISTS security_integration_credentials_scope_check;

ALTER TABLE security.integration_credentials
    ADD CONSTRAINT security_integration_credentials_scope_check
    CHECK (scope ~ '^[a-z][a-z0-9:_-]{0,63}$');

ALTER TABLE security.events
    ADD COLUMN IF NOT EXISTS integration_id UUID;

ALTER TABLE security.events
    DROP CONSTRAINT IF EXISTS security_events_integration_org_fk;

ALTER TABLE security.events
    ADD CONSTRAINT security_events_integration_org_fk
    FOREIGN KEY (integration_id, organization_id)
    REFERENCES security.integrations (id, organization_id)
    ON DELETE RESTRICT;
