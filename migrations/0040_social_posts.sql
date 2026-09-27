CREATE SCHEMA IF NOT EXISTS social;

CREATE TABLE IF NOT EXISTS social.posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    client_id UUID,
    campaign_id UUID,
    title TEXT NOT NULL,
    body TEXT,
    platform TEXT NOT NULL
        CHECK (platform IN ('LinkedIn', 'Instagram', 'Facebook', 'X', 'TikTok')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'review', 'approval', 'scheduled', 'published')),
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high')),
    scheduled_for TIMESTAMPTZ,
    estimated_hours NUMERIC(8, 2) NOT NULL DEFAULT 1,
    spent_hours NUMERIC(8, 2) NOT NULL DEFAULT 0,
    ai_angle TEXT,
    owner_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS social_posts_org_status_idx
    ON social.posts (organization_id, status, scheduled_for);
