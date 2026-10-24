-- Operator-run ONLY, through an existing authenticated psql session.
-- No migration runner, DDL, ledger repair, credentials or media rows.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SELECT json_build_object(
  'ledger', (SELECT coalesce(json_agg(row_to_json(m) ORDER BY version), '[]'::json)
             FROM platform.schema_migrations m),
  'columns', (SELECT coalesce(json_agg(row_to_json(c)), '[]'::json) FROM (
    SELECT table_schema, table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'media_platform'
       OR (table_schema = 'work' AND table_name = 'time_entries'
           AND column_name IN ('auto_stopped_at'))
    ORDER BY table_schema, table_name, ordinal_position
  ) c),
  'fencing_sequence', to_regclass('media_platform.fencing_tokens') IS NOT NULL
);
COMMIT;
