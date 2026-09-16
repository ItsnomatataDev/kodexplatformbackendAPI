
CREATE SCHEMA IF NOT EXISTS ingestion;

CREATE TABLE IF NOT EXISTS ingestion.sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(255) NOT NULL,
    source_type VARCHAR(50) NOT NULL,

    description TEXT,

    organization_id UUID,

    configuration JSONB NOT NULL DEFAULT '{}'::jsonb,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ingestion_sources_source_type_check
        CHECK (
            source_type IN (
                'file',
                'database',
                'api',
                'manual',
                'legacy_export'
            )
        )
);

CREATE TABLE IF NOT EXISTS ingestion.jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    source_id UUID NOT NULL
        REFERENCES ingestion.sources(id)
        ON DELETE RESTRICT,

    job_type VARCHAR(50) NOT NULL,

    status VARCHAR(50) NOT NULL DEFAULT 'pending',

    source_reference TEXT,

    input_filename TEXT,
    input_mime_type VARCHAR(255),
    input_size_bytes BIGINT,

    input_checksum VARCHAR(128),

    mapping_version VARCHAR(100),

    configuration JSONB NOT NULL DEFAULT '{}'::jsonb,

    statistics JSONB NOT NULL DEFAULT '{}'::jsonb,

    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ingestion_jobs_job_type_check
        CHECK (
            job_type IN (
                'import',
                'migration',
                'sync',
                'validation',
                'transformation'
            )
        ),

    CONSTRAINT ingestion_jobs_status_check
        CHECK (
            status IN (
                'pending',
                'processing',
                'completed',
                'failed',
                'cancelled',
                'partial'
            )
        )
);

CREATE TABLE IF NOT EXISTS ingestion.records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    job_id UUID NOT NULL
        REFERENCES ingestion.jobs(id)
        ON DELETE CASCADE,

    record_number BIGINT NOT NULL,

    raw_data JSONB NOT NULL,

    normalized_data JSONB,

    transformed_data JSONB,

    record_checksum VARCHAR(128),

    status VARCHAR(50) NOT NULL DEFAULT 'pending',

    error_count INTEGER NOT NULL DEFAULT 0,
    warning_count INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,

    CONSTRAINT ingestion_records_status_check
        CHECK (
            status IN (
                'pending',
                'processing',
                'normalized',
                'validated',
                'transformed',
                'accepted',
                'rejected',
                'needs_review'
            )
        ),

    CONSTRAINT ingestion_records_record_number_check
        CHECK (record_number > 0)
);

CREATE TABLE IF NOT EXISTS ingestion.errors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    job_id UUID NOT NULL
        REFERENCES ingestion.jobs(id)
        ON DELETE CASCADE,

    record_id UUID
        REFERENCES ingestion.records(id)
        ON DELETE CASCADE,

    severity VARCHAR(20) NOT NULL,

    field_name TEXT,
    error_code VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,

    details JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ingestion_errors_severity_check
        CHECK (
            severity IN (
                'error',
                'warning'
            )
        )
);

CREATE TABLE IF NOT EXISTS ingestion.transformations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    job_id UUID NOT NULL
        REFERENCES ingestion.jobs(id)
        ON DELETE CASCADE,

    record_id UUID
        REFERENCES ingestion.records(id)
        ON DELETE CASCADE,

    transformation_type VARCHAR(100) NOT NULL,

    mapping_version VARCHAR(100),

    input_data JSONB,

    output_data JSONB,

    confidence NUMERIC(5,4),

    performed_by VARCHAR(50) NOT NULL DEFAULT 'system',

    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ingestion_transformations_confidence_check
        CHECK (
            confidence IS NULL
            OR (
                confidence >= 0
                AND confidence <= 1
            )
        )
);

CREATE TABLE IF NOT EXISTS ingestion.quality_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    job_id UUID NOT NULL
        REFERENCES ingestion.jobs(id)
        ON DELETE CASCADE,

    record_id UUID
        REFERENCES ingestion.records(id)
        ON DELETE CASCADE,

    issue_type VARCHAR(100) NOT NULL,

    severity VARCHAR(20) NOT NULL DEFAULT 'warning',

    field_name TEXT,

    description TEXT NOT NULL,

    suggested_value JSONB,

    resolved_value JSONB,

    status VARCHAR(30) NOT NULL DEFAULT 'open',

    reviewed_by UUID,

    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ingestion_quality_issues_severity_check
        CHECK (
            severity IN (
                'info',
                'warning',
                'error',
                'critical'
            )
        ),

    CONSTRAINT ingestion_quality_issues_status_check
        CHECK (
            status IN (
                'open',
                'accepted',
                'resolved',
                'ignored'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source_id
    ON ingestion.jobs(source_id);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status
    ON ingestion.jobs(status);

CREATE INDEX IF NOT EXISTS idx_ingestion_records_job_id
    ON ingestion.records(job_id);

CREATE INDEX IF NOT EXISTS idx_ingestion_records_status
    ON ingestion.records(status);

CREATE INDEX IF NOT EXISTS idx_ingestion_errors_job_id
    ON ingestion.errors(job_id);

CREATE INDEX IF NOT EXISTS idx_ingestion_errors_record_id
    ON ingestion.errors(record_id);

CREATE INDEX IF NOT EXISTS idx_ingestion_quality_issues_job_id
    ON ingestion.quality_issues(job_id);

CREATE INDEX IF NOT EXISTS idx_ingestion_quality_issues_status
    ON ingestion.quality_issues(status);
