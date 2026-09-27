CREATE SCHEMA IF NOT EXISTS documents;

CREATE TABLE IF NOT EXISTS documents.employee_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    message TEXT,
    document_type TEXT NOT NULL DEFAULT 'payslip'
        CHECK (char_length(document_type) BETWEEN 1 AND 40),
    file_bucket TEXT,
    file_path TEXT,
    file_name TEXT,
    mime_type TEXT,
    size_bytes BIGINT,
    requires_acknowledgement BOOLEAN NOT NULL DEFAULT FALSE,
    is_confidential BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    expires_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_employee_docs_org_created_idx
    ON documents.employee_documents (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS documents.employee_document_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    document_id UUID NOT NULL
        REFERENCES documents.employee_documents(id)
        ON DELETE CASCADE,
    user_id UUID NOT NULL
        REFERENCES identity.users(id)
        ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'unread'
        CHECK (status IN ('unread', 'read', 'acknowledged', 'archived')),
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    acknowledgement_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT documents_recipient_doc_user_uq UNIQUE (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS documents_recipients_user_status_idx
    ON documents.employee_document_recipients (organization_id, user_id, status, delivered_at DESC);

CREATE TABLE IF NOT EXISTS documents.employee_document_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    document_id UUID NOT NULL
        REFERENCES documents.employee_documents(id)
        ON DELETE CASCADE,
    recipient_id UUID
        REFERENCES documents.employee_document_recipients(id)
        ON DELETE SET NULL,
    actor_user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    action TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_audit_doc_idx
    ON documents.employee_document_audit_logs (document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS documents.payslip_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    title TEXT NOT NULL,
    payroll_month INT NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
    payroll_year INT NOT NULL CHECK (payroll_year BETWEEN 2000 AND 2100),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'delivered', 'cancelled')),
    created_by UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents.payslip_batch_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
        REFERENCES organizations.organizations(id)
        ON DELETE CASCADE,
    batch_id UUID NOT NULL
        REFERENCES documents.payslip_batches(id)
        ON DELETE CASCADE,
    user_id UUID
        REFERENCES identity.users(id)
        ON DELETE SET NULL,
    match_key TEXT,
    file_path TEXT,
    file_name TEXT,
    mime_type TEXT,
    size_bytes BIGINT,
    document_id UUID
        REFERENCES documents.employee_documents(id)
        ON DELETE SET NULL,
    recipient_id UUID
        REFERENCES documents.employee_document_recipients(id)
        ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'matched'
        CHECK (status IN ('unmatched', 'matched', 'delivered', 'failed', 'skipped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_payslip_batch_items_batch_idx
    ON documents.payslip_batch_items (batch_id, created_at ASC);

UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{documents}',
    COALESCE(permissions->'documents', '{}'::jsonb) || '{
      "read": true,
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

-- All active roles can read their own inbox documents.
UPDATE organizations.roles
SET
  permissions = jsonb_set(
    COALESCE(permissions, '{}'::jsonb),
    '{documents}',
    COALESCE(permissions->'documents', '{}'::jsonb) || '{
      "read": true
    }'::jsonb
  ),
  updated_at = NOW()
WHERE is_active = TRUE
  AND role_key NOT IN ('admin', 'manager', 'it');
