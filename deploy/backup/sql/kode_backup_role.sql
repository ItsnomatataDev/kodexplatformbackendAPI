\set ON_ERROR_STOP on

CREATE ROLE kode_backup WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD :'kode_backup_password';

GRANT CONNECT ON DATABASE kode_platform_staging TO kode_backup;

DO $$
DECLARE
  schema_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kode_staging') THEN
    RAISE EXCEPTION 'kode_staging must already exist on this instance';
  END IF;

  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO kode_backup', schema_name);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO kode_backup', schema_name);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO kode_backup', schema_name);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE kode_staging IN SCHEMA %I GRANT SELECT ON TABLES TO kode_backup',
      schema_name
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE kode_staging IN SCHEMA %I GRANT SELECT ON SEQUENCES TO kode_backup',
      schema_name
    );
  END LOOP;
END $$;
