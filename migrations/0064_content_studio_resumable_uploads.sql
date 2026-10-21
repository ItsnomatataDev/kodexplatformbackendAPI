BEGIN;

CREATE UNIQUE INDEX content_schedules_id_org_office_uq
    ON content.schedules (id, organization_id, office_id);
CREATE UNIQUE INDEX content_clients_id_org_office_uq
    ON content.clients (id, organization_id, office_id);

CREATE TABLE content.upload_sessions (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id) ON DELETE CASCADE,
    created_by UUID NOT NULL
        REFERENCES identity.users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL
        CHECK (target_type IN ('schedule_asset', 'client_media')),
    schedule_id UUID,
    client_id UUID,
    office_id UUID NOT NULL
        REFERENCES organizations.offices(id) ON DELETE RESTRICT,
    bucket TEXT NOT NULL,
    object_key TEXT NOT NULL,
    provider_upload_id TEXT,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes > 0),
    part_size_bytes INTEGER NOT NULL CHECK (part_size_bytes BETWEEN 8388608 AND 16777216),
    expected_part_count INTEGER NOT NULL CHECK (expected_part_count BETWEEN 1 AND 10000),
    target_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    media_record_id UUID NOT NULL,
    asset_record_id UUID,
    state TEXT NOT NULL CHECK (state IN (
        'initiating', 'uploading', 'completing', 'completed',
        'aborting', 'aborted', 'expired', 'failed'
    )),
    completion_owner UUID,
    completion_lease_until TIMESTAMPTZ,
    completion_result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,

    CONSTRAINT content_upload_sessions_target_check CHECK (
        (target_type = 'schedule_asset' AND schedule_id IS NOT NULL AND client_id IS NULL)
        OR
        (target_type = 'client_media' AND client_id IS NOT NULL AND schedule_id IS NULL)
    ),
    CONSTRAINT content_upload_sessions_schedule_fk
        FOREIGN KEY (schedule_id, organization_id, office_id)
        REFERENCES content.schedules(id, organization_id, office_id)
        ON DELETE CASCADE,
    CONSTRAINT content_upload_sessions_client_fk
        FOREIGN KEY (client_id, organization_id, office_id)
        REFERENCES content.clients(id, organization_id, office_id)
        ON DELETE CASCADE,
    CONSTRAINT content_upload_sessions_part_count_check CHECK (
        expected_part_count =
        ((expected_size_bytes + part_size_bytes - 1) / part_size_bytes)
    ),
    CONSTRAINT content_upload_sessions_unique_object UNIQUE (bucket, object_key),
    CONSTRAINT content_upload_sessions_unique_provider_upload
        UNIQUE (bucket, provider_upload_id)
);

CREATE TABLE content.upload_session_parts (
    session_id UUID NOT NULL
        REFERENCES content.upload_sessions(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
    size_bytes BIGINT,
    etag TEXT,
    state TEXT NOT NULL DEFAULT 'committed'
        CHECK (state IN ('uploading', 'committed')),
    claim_token UUID,
    lease_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, part_number),
    CONSTRAINT content_upload_session_parts_claim_check CHECK (
        (
            state = 'uploading' AND claim_token IS NOT NULL
            AND lease_until IS NOT NULL AND size_bytes IS NULL AND etag IS NULL
        )
        OR (
            state = 'committed' AND claim_token IS NULL AND lease_until IS NULL
            AND size_bytes IS NOT NULL AND size_bytes > 0
            AND etag IS NOT NULL AND length(etag) BETWEEN 1 AND 256
        )
    )
);

CREATE INDEX content_upload_sessions_owner_active_idx
    ON content.upload_sessions (organization_id, created_by, state, expires_at);
CREATE INDEX content_upload_sessions_expiry_idx
    ON content.upload_sessions (expires_at, updated_at)
    WHERE state IN ('initiating', 'uploading', 'completing', 'aborting');
CREATE INDEX content_upload_sessions_recovery_idx
    ON content.upload_sessions (state, updated_at)
    WHERE state IN ('initiating', 'completing', 'aborting');
CREATE INDEX content_upload_session_parts_leases_idx
    ON content.upload_session_parts (lease_until)
    WHERE state = 'uploading';

COMMENT ON TABLE content.upload_sessions IS
    'Durable, organization-scoped multipart upload sessions. Storage credentials are never persisted.';
COMMENT ON TABLE content.upload_session_parts IS
    'Server-observed multipart parts and temporary cross-process upload claims.';

COMMIT;
