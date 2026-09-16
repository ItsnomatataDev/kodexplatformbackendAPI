CREATE TABLE IF NOT EXISTS identity.password_credentials (
    user_id UUID PRIMARY KEY
        REFERENCES identity.users(id)
        ON DELETE CASCADE,

    password_hash TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'argon2id',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT password_credentials_algorithm_check
        CHECK (algorithm = 'argon2id')
);

CREATE TABLE IF NOT EXISTS identity.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,

    ip_address TEXT,
    user_agent TEXT,

    CONSTRAINT sessions_expiry_check
        CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS sessions_user_active_idx
    ON identity.sessions (user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS sessions_expires_idx
    ON identity.sessions (expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS identity.refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    session_id UUID NOT NULL
        REFERENCES identity.sessions(id)
        ON DELETE CASCADE,

    token_hash TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    replaced_by UUID
        REFERENCES identity.refresh_tokens(id)
        ON DELETE SET NULL,

    CONSTRAINT refresh_tokens_token_hash_unique
        UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS refresh_tokens_session_idx
    ON identity.refresh_tokens (session_id);

CREATE TABLE IF NOT EXISTS identity.password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,

    token_hash TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,

    CONSTRAINT password_reset_tokens_token_hash_unique
        UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
    ON identity.password_reset_tokens (user_id);
