CREATE SCHEMA IF NOT EXISTS meetings;

CREATE TABLE IF NOT EXISTS meetings.meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    host_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
    meeting_type TEXT NOT NULL DEFAULT 'video'
        CHECK (meeting_type IN ('audio', 'video')),
    room_code TEXT NOT NULL,
    livekit_room_name TEXT,
    meet_url TEXT,
    allow_guest_access BOOLEAN NOT NULL DEFAULT FALSE,
    guest_code TEXT,
    scheduled_start TIMESTAMPTZ,
    scheduled_for TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meetings_org_status_created_idx
    ON meetings.meetings (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS meetings_org_scheduled_idx
    ON meetings.meetings (organization_id, scheduled_start);

CREATE TABLE IF NOT EXISTS meetings.participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL
        REFERENCES meetings.meetings(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'participant'
        CHECK (role IN ('host', 'participant')),
    joined_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    is_muted BOOLEAN NOT NULL DEFAULT TRUE,
    is_camera_on BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT meetings_participants_meeting_user_uq UNIQUE (meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS meetings_participants_meeting_idx
    ON meetings.participants (meeting_id);

CREATE TABLE IF NOT EXISTS meetings.guests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL
        REFERENCES meetings.meetings(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    joined_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    is_muted BOOLEAN NOT NULL DEFAULT TRUE,
    is_camera_on BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meetings.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL
        REFERENCES meetings.meetings(id)
        ON DELETE CASCADE,
    sender_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meetings_messages_meeting_created_idx
    ON meetings.messages (meeting_id, created_at ASC);

CREATE TABLE IF NOT EXISTS meetings.signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL
        REFERENCES meetings.meetings(id)
        ON DELETE CASCADE,
    sender_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    signal_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meetings_signals_meeting_created_idx
    ON meetings.signals (meeting_id, created_at DESC);
