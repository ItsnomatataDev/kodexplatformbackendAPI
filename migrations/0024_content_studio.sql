CREATE SCHEMA IF NOT EXISTS content;

CREATE TABLE IF NOT EXISTS content.clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID NOT NULL
        REFERENCES organizations.offices(id)
        ON DELETE RESTRICT,
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    internal_reviewer_email TEXT,
    portal_token TEXT NOT NULL UNIQUE,
    login_pin_hash TEXT NOT NULL,
    pin_last_generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pin_expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ai_voice_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    ai_caption_examples JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS content_clients_org_office_idx
    ON content.clients (organization_id, office_id, created_at DESC);

CREATE INDEX IF NOT EXISTS content_clients_portal_token_idx
    ON content.clients (portal_token);

CREATE TABLE IF NOT EXISTS content.schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID NOT NULL
        REFERENCES organizations.offices(id)
        ON DELETE RESTRICT,
    client_id UUID
        REFERENCES content.clients(id)
        ON DELETE SET NULL,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    assigned_to UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    body TEXT,
    summary TEXT,
    captions TEXT,
    notes TEXT,
    layout_type TEXT NOT NULL DEFAULT 'article',
    cta_label TEXT,
    cta_url TEXT,
    review_token TEXT NOT NULL UNIQUE,
    review_url TEXT,
    slug TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    review_status TEXT,
    scheduled_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    approved_by_name TEXT,
    approved_by_email TEXT,
    changes_requested_at TIMESTAMPTZ,
    last_viewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT content_schedules_status_check CHECK (status IN (
        'draft',
        'ready_for_review',
        'sent_to_client',
        'viewed',
        'changes_requested',
        'approved',
        'published',
        'archived'
    ))
);

CREATE INDEX IF NOT EXISTS content_schedules_org_office_idx
    ON content.schedules (organization_id, office_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS content_schedules_client_idx
    ON content.schedules (client_id, scheduled_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS content_schedules_token_idx
    ON content.schedules (review_token);

-- One active (non-archived) schedule per client per calendar month.
CREATE UNIQUE INDEX IF NOT EXISTS content_schedules_client_month_uq
    ON content.schedules (
        client_id,
        (date_trunc('month', scheduled_at AT TIME ZONE 'UTC'))
    )
    WHERE client_id IS NOT NULL
      AND scheduled_at IS NOT NULL
      AND status IS DISTINCT FROM 'archived';

CREATE TABLE IF NOT EXISTS content.client_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL
        REFERENCES content.clients(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID NOT NULL
        REFERENCES organizations.offices(id)
        ON DELETE RESTRICT,
    uploaded_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    storage_path TEXT,
    bucket TEXT NOT NULL DEFAULT 'content-review-assets',
    mime_type TEXT,
    asset_type TEXT NOT NULL DEFAULT 'image',
    label TEXT,
    original_size_bytes BIGINT,
    stored_size_bytes BIGINT,
    compression_status TEXT NOT NULL DEFAULT 'not_applicable',
    web_playback_status TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS content_client_media_client_idx
    ON content.client_media (client_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS content_client_media_path_uq
    ON content.client_media (client_id, storage_path)
    WHERE storage_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS content.schedule_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id UUID NOT NULL
        REFERENCES content.schedules(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID NOT NULL
        REFERENCES organizations.offices(id)
        ON DELETE RESTRICT,
    library_media_id UUID
        REFERENCES content.client_media(id)
        ON DELETE SET NULL,
    uploaded_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    storage_path TEXT,
    bucket TEXT NOT NULL DEFAULT 'content-review-assets',
    mime_type TEXT,
    asset_type TEXT NOT NULL DEFAULT 'image',
    heading TEXT,
    caption TEXT,
    is_selected BOOLEAN NOT NULL DEFAULT TRUE,
    crop_x NUMERIC,
    crop_y NUMERIC,
    crop_zoom NUMERIC,
    sort_order INT NOT NULL DEFAULT 0,
    display_slot INT NOT NULL DEFAULT 0,
    original_size_bytes BIGINT,
    stored_size_bytes BIGINT,
    compression_status TEXT NOT NULL DEFAULT 'not_applicable',
    web_playback_status TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS content_schedule_assets_schedule_idx
    ON content.schedule_assets (schedule_id, display_slot, sort_order);

CREATE INDEX IF NOT EXISTS content_schedule_assets_library_idx
    ON content.schedule_assets (library_media_id)
    WHERE library_media_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS content.comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id UUID NOT NULL
        REFERENCES content.schedules(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID NOT NULL
        REFERENCES organizations.offices(id)
        ON DELETE RESTRICT,
    parent_comment_id UUID
        REFERENCES content.comments(id)
        ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    author_email TEXT,
    body TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'internal',
    visibility TEXT NOT NULL DEFAULT 'internal',
    author_type TEXT NOT NULL DEFAULT 'internal',
    comment_type TEXT NOT NULL DEFAULT 'internal_comment',
    display_slot INT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS content_comments_schedule_idx
    ON content.comments (schedule_id, created_at ASC);

CREATE TABLE IF NOT EXISTS content.activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id UUID NOT NULL
        REFERENCES content.schedules(id)
        ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    office_id UUID NOT NULL
        REFERENCES organizations.offices(id)
        ON DELETE RESTRICT,
    actor_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    activity_type TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS content_activity_schedule_idx
    ON content.activity (schedule_id, created_at DESC);

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{content_studio}',
    COALESCE(permissions->'content_studio', '{}'::jsonb) || '{
      "read": true,
      "manage": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN (
  'admin',
  'manager',
  'it',
  'media_team',
  'social_media'
)
AND is_active = TRUE;

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{content_studio}',
    COALESCE(permissions->'content_studio', '{}'::jsonb) || '{
      "approve": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN (
  'admin',
  'manager',
  'it',
  'social_media'
)
AND is_active = TRUE;
