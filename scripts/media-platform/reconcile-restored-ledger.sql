-- ISOLATED RESTORE REHEARSAL ONLY.
-- Never execute against production.
-- Must be reviewed before execution.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $$
DECLARE
  ledger_count integer;
  media_count integer;
  lease_count integer;
  column_count integer;
  index_count integer;
  constraint_count integer;
BEGIN
  SELECT count(*) INTO ledger_count
  FROM platform.schema_migrations;

  IF ledger_count <> 57 THEN
    RAISE EXCEPTION
      'Unexpected migration ledger count: %', ledger_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM platform.schema_migrations
    WHERE version IN ('0058', '0059')
       OR version LIKE '0058_%'
       OR version LIKE '0059_%'
  ) THEN
    RAISE EXCEPTION 'Media migrations already recorded';
  END IF;

  SELECT count(*) INTO media_count
  FROM information_schema.tables
  WHERE table_schema = 'media_platform'
    AND table_name IN ('assets', 'jobs', 'variants');

  IF media_count <> 3 THEN
    RAISE EXCEPTION
      'Unexpected media table count: %', media_count;
  END IF;

  SELECT count(*) INTO lease_count
  FROM information_schema.columns
  WHERE table_schema = 'media_platform'
    AND table_name = 'jobs'
    AND column_name IN ('lease_owner', 'lease_expires_at');

  SELECT count(*) INTO column_count
  FROM information_schema.columns
  WHERE table_schema = 'media_platform';

  IF column_count <> 43 THEN
    RAISE EXCEPTION 'Unexpected media column count: %', column_count;
  END IF;

  SELECT count(*) INTO index_count
  FROM pg_indexes
  WHERE schemaname = 'media_platform';

  IF index_count <> 12 THEN
    RAISE EXCEPTION 'Unexpected media index count: %', index_count;
  END IF;

  SELECT count(*) INTO constraint_count
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'media_platform';

  IF constraint_count <> 20 THEN
    RAISE EXCEPTION 'Unexpected media constraint count: %', constraint_count;
  END IF;

  IF lease_count <> 2 THEN
    RAISE EXCEPTION 'Media job leasing schema is incomplete';
  END IF;
END $$;

-- These ledger identities match the original migration files.
INSERT INTO platform.schema_migrations(version, description)
VALUES
  ('0058', 'media_platform'),
  ('0059', 'media_job_leases');

ROLLBACK;

-- REVIEW MODE:
-- All assertions and INSERT statements execute inside a transaction,
-- but no changes are persisted.
-- Replace ROLLBACK only after explicit approval for isolated rehearsal.
