-- Organization branding + domain management (Supabase organization_branding / domains cutover).

CREATE TABLE IF NOT EXISTS organizations.branding (
    organization_id UUID PRIMARY KEY
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,

    brand_name TEXT,
    app_name TEXT,
    logo_url TEXT,
    logo_object_key TEXT,
    favicon_url TEXT,
    favicon_object_key TEXT,
    login_background_url TEXT,
    primary_color TEXT DEFAULT '#000000',
    secondary_color TEXT DEFAULT '#ffffff',
    accent_color TEXT DEFAULT '#f97316',
    background_color TEXT,
    card_color TEXT,
    sidebar_color TEXT,
    topbar_color TEXT,
    text_color TEXT,
    muted_text_color TEXT,
    border_color TEXT,
    button_color TEXT,
    button_text_color TEXT,
    button_hover_color TEXT,
    link_color TEXT,
    link_hover_color TEXT,
    input_focus_color TEXT,
    company_slogan TEXT,
    company_welcome_text TEXT,
    dashboard_greeting_text TEXT,
    custom_terminology JSONB NOT NULL DEFAULT '{}'::jsonb,
    invitation_template TEXT,
    onboarding_wording JSONB NOT NULL DEFAULT '{}'::jsonb,
    custom_css JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    dns_target TEXT DEFAULT 'cname.vercel-dns.com',
    domain_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations.domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    domain TEXT NOT NULL,
    domain_type TEXT NOT NULL
        CHECK (domain_type IN ('subdomain', 'custom_domain')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',
            'dns_pending',
            'verified',
            'connected',
            'failed',
            'disabled'
        )),
    cname_host TEXT NOT NULL DEFAULT 'www',
    cname_target TEXT NOT NULL DEFAULT 'cname.vercel-dns.com',
    txt_host TEXT NOT NULL DEFAULT '_kode-verify',
    txt_value TEXT NOT NULL,
    verified_at TIMESTAMPTZ,
    connected_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    last_error TEXT,
    ssl_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (ssl_status IN ('pending', 'issuing', 'active', 'failed')),
    provider TEXT NOT NULL DEFAULT 'kode',
    provider_domain_id TEXT,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT organizations_domains_org_domain_uq UNIQUE (organization_id, domain)
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_domains_domain_unique
    ON organizations.domains (lower(domain));

CREATE INDEX IF NOT EXISTS organizations_domains_org_idx
    ON organizations.domains (organization_id, created_at DESC);

-- Seed branding rows from existing organization columns when missing.
INSERT INTO organizations.branding (
    organization_id,
    brand_name,
    app_name,
    logo_url,
    primary_color,
    secondary_color
)
SELECT
    o.id,
    o.name,
    o.name,
    o.logo_url,
    COALESCE(o.primary_color, '#000000'),
    COALESCE(o.secondary_color, '#ffffff')
FROM organizations.organizations o
WHERE NOT EXISTS (
    SELECT 1
    FROM organizations.branding b
    WHERE b.organization_id = o.id
);

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{organization}',
    COALESCE(permissions->'organization', '{}'::jsonb) || '{
      "branding_read": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE is_active = TRUE;

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{organization}',
    COALESCE(permissions->'organization', '{}'::jsonb) || '{
      "branding_manage": true,
      "domains_manage": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE role_key IN ('admin', 'manager', 'it')
  AND is_active = TRUE;
