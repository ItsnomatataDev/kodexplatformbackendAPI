-- AI workspace + automation flows/runs
CREATE SCHEMA IF NOT EXISTS ai;

CREATE TABLE IF NOT EXISTS ai.assistants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    model TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_assistants_org_idx
    ON ai.assistants (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_projects_org_idx
    ON ai.projects (organization_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS ai_projects_user_idx
    ON ai.projects (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai.chat_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    assistant_id UUID
        REFERENCES ai.assistants(id)
        ON DELETE SET NULL,
    project_id UUID
        REFERENCES ai.projects(id)
        ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT 'New chat',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_chat_threads_org_user_idx
    ON ai.chat_threads (organization_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai.chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    thread_id UUID NOT NULL
        REFERENCES ai.chat_threads(id)
        ON DELETE CASCADE,
    role TEXT NOT NULL
        CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL DEFAULT '',
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_chat_messages_thread_idx
    ON ai.chat_messages (thread_id, created_at ASC);

CREATE TABLE IF NOT EXISTS ai.automation_flows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_automation_flows_org_idx
    ON ai.automation_flows (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai.automation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    flow_id UUID NOT NULL
        REFERENCES ai.automation_flows(id)
        ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_automation_runs_org_idx
    ON ai.automation_runs (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_automation_runs_flow_idx
    ON ai.automation_runs (flow_id, created_at DESC);
