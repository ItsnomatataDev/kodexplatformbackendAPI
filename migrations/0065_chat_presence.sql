CREATE TABLE IF NOT EXISTS chat.user_presence (
    organization_id UUID NOT NULL REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (organization_id, user_id)
);
