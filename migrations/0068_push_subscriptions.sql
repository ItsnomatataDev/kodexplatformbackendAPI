-- Mobile Expo push token persistence for Kode (replaces legacy public.push_subscriptions).

CREATE TABLE IF NOT EXISTS notifications.push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'unknown',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT push_subscriptions_endpoint_nonempty
        CHECK (length(trim(endpoint)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_user_endpoint_uidx
    ON notifications.push_subscriptions (user_id, endpoint);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx
    ON notifications.push_subscriptions (organization_id, user_id)
    WHERE is_active = TRUE;
