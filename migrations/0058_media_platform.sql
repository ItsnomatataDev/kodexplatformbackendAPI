BEGIN;

CREATE SCHEMA IF NOT EXISTS media_platform;

-- ============================================================
-- MEDIA ASSETS
-- One logical uploaded media object.
-- ============================================================

CREATE TABLE IF NOT EXISTS media_platform.assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,

    uploaded_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,

    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),

    origin_bucket TEXT NOT NULL,
    origin_object_key TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'uploaded'
        CHECK (
            status IN (
                'uploading',
                'uploaded',
                'processing',
                'ready',
                'failed',
                'deleted'
            )
        ),

    error_code TEXT,
    error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (origin_bucket, origin_object_key)
);

CREATE INDEX IF NOT EXISTS media_platform_assets_org_created_idx
    ON media_platform.assets (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS media_platform_assets_status_idx
    ON media_platform.assets (status, created_at);


-- ============================================================
-- MEDIA VARIANTS
-- Generated files: MP4, HLS renditions, thumbnails, etc.
-- ============================================================

CREATE TABLE IF NOT EXISTS media_platform.variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    asset_id UUID NOT NULL
        REFERENCES media_platform.assets(id)
        ON DELETE CASCADE,

    kind TEXT NOT NULL,

    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),

    bitrate_bps INTEGER CHECK (
        bitrate_bps IS NULL OR bitrate_bps > 0
    ),

    codec TEXT,
    container TEXT,

    bucket TEXT NOT NULL,
    object_key TEXT NOT NULL,

    size_bytes BIGINT CHECK (
        size_bytes IS NULL OR size_bytes >= 0
    ),

    status TEXT NOT NULL DEFAULT 'processing'
        CHECK (
            status IN (
                'processing',
                'ready',
                'failed',
                'deleted'
            )
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (bucket, object_key)
);

CREATE INDEX IF NOT EXISTS media_platform_variants_asset_idx
    ON media_platform.variants (asset_id, kind);

CREATE INDEX IF NOT EXISTS media_platform_variants_status_idx
    ON media_platform.variants (status);


-- ============================================================
-- PROCESSING JOBS
-- Durable queue/history for media processing.
-- ============================================================

CREATE TABLE IF NOT EXISTS media_platform.jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    asset_id UUID NOT NULL
        REFERENCES media_platform.assets(id)
        ON DELETE CASCADE,

    job_type TEXT NOT NULL
        CHECK (
            job_type IN (
                'playback_mp4',
                'adaptive_hls',
                'thumbnail',
                'metadata'
            )
        ),

    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (
            status IN (
                'queued',
                'processing',
                'completed',
                'failed',
                'cancelled'
            )
        ),

    priority INTEGER NOT NULL DEFAULT 100,

    attempts INTEGER NOT NULL DEFAULT 0
        CHECK (attempts >= 0),

    max_attempts INTEGER NOT NULL DEFAULT 3
        CHECK (max_attempts > 0),

    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    error_code TEXT,
    error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS media_platform_jobs_queue_idx
    ON media_platform.jobs (
        status,
        priority,
        available_at,
        created_at
    );

CREATE INDEX IF NOT EXISTS media_platform_jobs_asset_idx
    ON media_platform.jobs (asset_id, created_at DESC);

COMMIT;
