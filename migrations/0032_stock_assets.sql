CREATE SCHEMA IF NOT EXISTS stock;

CREATE TABLE IF NOT EXISTS stock.categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT stock_categories_org_name_uq UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS stock.locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT,
    image_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT stock_locations_org_name_uq UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS stock.purchase_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    reference_number TEXT,
    invoice_number TEXT,
    purchase_date DATE,
    vendor_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock.assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    purchase_batch_id UUID
        REFERENCES stock.purchase_batches(id)
        ON DELETE SET NULL,
    category_id UUID
        REFERENCES stock.categories(id)
        ON DELETE SET NULL,
    current_location_id UUID
        REFERENCES stock.locations(id)
        ON DELETE SET NULL,
    asset_name TEXT NOT NULL,
    asset_tag TEXT,
    serial_number TEXT NOT NULL,
    brand TEXT,
    model TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'in_stock'
        CHECK (status IN ('in_stock', 'assigned', 'in_repair', 'retired', 'lost', 'disposed')),
    condition TEXT NOT NULL DEFAULT 'new'
        CHECK (condition IN ('new', 'excellent', 'good', 'fair', 'damaged')),
    purchase_price NUMERIC(14, 2),
    currency TEXT NOT NULL DEFAULT 'USD',
    purchase_date DATE,
    warranty_expiry_date DATE,
    expected_life_months INT,
    invoice_number TEXT,
    reference_number TEXT,
    insured BOOLEAN NOT NULL DEFAULT FALSE,
    insurance_provider TEXT,
    insurance_policy_number TEXT,
    insurance_expiry_date DATE,
    sub_location TEXT,
    barcode_value TEXT,
    qr_code_value TEXT,
    asset_image_url TEXT,
    site_image_url TEXT,
    asset_image_width INT,
    asset_image_height INT,
    site_image_width INT,
    site_image_height INT,
    notes TEXT,
    assigned_to UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    assigned_project_id UUID,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_assets_org_created_idx
    ON stock.assets (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_assets_org_status_idx
    ON stock.assets (organization_id, status);
CREATE INDEX IF NOT EXISTS stock_assets_org_tag_idx
    ON stock.assets (organization_id, asset_tag);

CREATE TABLE IF NOT EXISTS stock.asset_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    asset_id UUID NOT NULL
        REFERENCES stock.assets(id)
        ON DELETE CASCADE,
    assigned_to UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    assigned_project_id UUID,
    assigned_location_id UUID
        REFERENCES stock.locations(id)
        ON DELETE SET NULL,
    assigned_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_back_at TIMESTAMPTZ,
    returned_at TIMESTAMPTZ,
    returned_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'returned', 'overdue', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_assignments_asset_status_idx
    ON stock.asset_assignments (asset_id, status, assigned_at DESC);

CREATE TABLE IF NOT EXISTS stock.asset_maintenance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    asset_id UUID NOT NULL
        REFERENCES stock.assets(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    service_vendor_id UUID,
    cost NUMERIC(14, 2),
    service_date DATE,
    next_service_date DATE,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock.asset_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    asset_id UUID NOT NULL
        REFERENCES stock.assets(id)
        ON DELETE CASCADE,
    checked_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    found_location_id UUID
        REFERENCES stock.locations(id)
        ON DELETE SET NULL,
    found_condition TEXT,
    remarks TEXT
);
