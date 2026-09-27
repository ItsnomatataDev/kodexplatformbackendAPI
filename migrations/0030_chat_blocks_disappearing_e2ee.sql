-- Chat safety, disappearing messages, and E2EE key envelopes.

ALTER TABLE chat.conversations
  ADD COLUMN IF NOT EXISTS disappearing_seconds INT
    CHECK (
      disappearing_seconds IS NULL
      OR disappearing_seconds IN (3600, 86400, 604800, 2592000)
    );

ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS chat_messages_expires_at_idx
  ON chat.messages (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat.user_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    blocker_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    blocked_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    conversation_id UUID
        REFERENCES chat.conversations(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chat_user_blocks_pair_uq UNIQUE (blocker_id, blocked_id),
    CONSTRAINT chat_user_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS chat_user_blocks_blocker_idx
  ON chat.user_blocks (organization_id, blocker_id);

CREATE TABLE IF NOT EXISTS chat.user_key_material (
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    key_fingerprint TEXT NOT NULL,
    public_wrap_key TEXT NOT NULL,
    key_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, organization_id),
    CONSTRAINT chat_user_key_material_version_check CHECK (key_version >= 1)
);

CREATE TABLE IF NOT EXISTS chat.conversation_key_envelopes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    conversation_id UUID NOT NULL
        REFERENCES chat.conversations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    wrapped_key TEXT NOT NULL,
    key_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chat_conversation_key_envelopes_uq
        UNIQUE (conversation_id, user_id, key_version),
    CONSTRAINT chat_conversation_key_envelopes_version_check CHECK (key_version >= 1)
);

CREATE INDEX IF NOT EXISTS chat_conversation_key_envelopes_user_idx
  ON chat.conversation_key_envelopes (organization_id, user_id, conversation_id);
