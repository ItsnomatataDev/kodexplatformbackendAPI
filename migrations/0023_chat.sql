CREATE SCHEMA IF NOT EXISTS chat;

CREATE TABLE IF NOT EXISTS chat.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID
        REFERENCES organizations.offices(id)
        ON DELETE SET NULL,
    title TEXT,
    type TEXT NOT NULL DEFAULT 'direct',
    created_by UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chat_conversations_type_check
        CHECK (type IN ('direct', 'group', 'department', 'announcement'))
);

CREATE INDEX IF NOT EXISTS chat_conversations_org_last_message_idx
    ON chat.conversations (organization_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS chat.conversation_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL
        REFERENCES chat.conversations(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    last_read_message_id UUID,
    last_read_at TIMESTAMPTZ,
    CONSTRAINT chat_conversation_members_role_check
        CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT chat_conversation_members_unique
        UNIQUE (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS chat_conversation_members_user_idx
    ON chat.conversation_members (user_id);

CREATE TABLE IF NOT EXISTS chat.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL
        REFERENCES chat.conversations(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    sender_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE RESTRICT,
    body TEXT,
    message_type TEXT NOT NULL DEFAULT 'text',
    reply_to_message_id UUID
        REFERENCES chat.messages(id)
        ON DELETE SET NULL,
    attachment_url TEXT,
    attachment_name TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_edited BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chat_messages_type_check
        CHECK (message_type IN ('text', 'image', 'audio', 'file', 'system'))
);

ALTER TABLE chat.conversation_members
    DROP CONSTRAINT IF EXISTS chat_conversation_members_last_read_fk;

ALTER TABLE chat.conversation_members
    ADD CONSTRAINT chat_conversation_members_last_read_fk
    FOREIGN KEY (last_read_message_id)
    REFERENCES chat.messages(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS chat_messages_conversation_created_idx
    ON chat.messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_messages_org_created_idx
    ON chat.messages (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat.message_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL
        REFERENCES chat.messages(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chat_message_reactions_unique
        UNIQUE (message_id, user_id, emoji),
    CONSTRAINT chat_message_reactions_emoji_check
        CHECK (char_length(emoji) BETWEEN 1 AND 32)
);

CREATE INDEX IF NOT EXISTS chat_message_reactions_message_idx
    ON chat.message_reactions (message_id);

-- Direct conversations: at most one open 1:1 pair per org (unordered pair key).
CREATE TABLE IF NOT EXISTS chat.direct_pairs (
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    user_a UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    user_b UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    conversation_id UUID NOT NULL
        REFERENCES chat.conversations(id)
        ON DELETE CASCADE,
    PRIMARY KEY (organization_id, user_a, user_b),
    CONSTRAINT chat_direct_pairs_ordered CHECK (user_a < user_b)
);

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{chat}',
    COALESCE(permissions->'chat', '{}'::jsonb) || '{
      "read": true,
      "write": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN (
  'admin',
  'manager',
  'it',
  'media_team',
  'social_media',
  'seo_specialist'
)
AND is_active = TRUE;

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{chat}',
    COALESCE(permissions->'chat', '{}'::jsonb) || '{
      "manage": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN (
  'admin',
  'manager',
  'it'
)
AND is_active = TRUE;
