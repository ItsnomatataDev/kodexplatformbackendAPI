CREATE TABLE IF NOT EXISTS ai.agent_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    thread_id UUID NOT NULL
        REFERENCES ai.chat_threads(id)
        ON DELETE CASCADE,
    message_id UUID
        REFERENCES ai.chat_messages(id)
        ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    results JSONB NOT NULL DEFAULT '[]'::jsonb,
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_plans_status_valid
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'expired'))
);

CREATE INDEX IF NOT EXISTS agent_plans_thread_idx
    ON ai.agent_plans (organization_id, thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai.scheduled_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    thread_id UUID
        REFERENCES ai.chat_threads(id)
        ON DELETE SET NULL,
    plan_id UUID
        REFERENCES ai.agent_plans(id)
        ON DELETE SET NULL,
    action TEXT NOT NULL,
    args JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary TEXT NOT NULL,
    run_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    result JSONB,
    error TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT scheduled_actions_status_valid
        CHECK (status IN ('scheduled', 'running', 'done', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS scheduled_actions_due_idx
    ON ai.scheduled_actions (run_at)
    WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS scheduled_actions_user_idx
    ON ai.scheduled_actions (organization_id, user_id, run_at DESC);
