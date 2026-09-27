CREATE SCHEMA IF NOT EXISTS university;

CREATE TABLE IF NOT EXISTS university.modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    app_route TEXT,
    icon_key TEXT NOT NULL DEFAULT 'book',
    illustration_url TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    required_roles TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS university.topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id UUID NOT NULL
        REFERENCES university.modules(id)
        ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    content_md TEXT NOT NULL DEFAULT '',
    illustration_url TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    estimated_minutes INT NOT NULL DEFAULT 5,
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT university_topics_module_slug_uq UNIQUE (module_id, slug)
);

CREATE INDEX IF NOT EXISTS university_topics_module_idx
    ON university.topics (module_id, sort_order);

CREATE TABLE IF NOT EXISTS university.topic_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    topic_id UUID NOT NULL
        REFERENCES university.topics(id)
        ON DELETE CASCADE,
    module_id UUID NOT NULL
        REFERENCES university.modules(id)
        ON DELETE CASCADE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    self_attested BOOLEAN NOT NULL DEFAULT TRUE,
    attestation_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT university_topic_progress_uq UNIQUE (user_id, topic_id)
);

CREATE INDEX IF NOT EXISTS university_progress_org_user_idx
    ON university.topic_progress (organization_id, user_id);
