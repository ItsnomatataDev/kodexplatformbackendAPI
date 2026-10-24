-- REVIEW ONLY: run with the designated migration administrator against the approved auth DB.
-- Apply migration 0063 transactionally FIRST. It creates separate NOLOGIN privilege groups.
-- Real login names/passwords must be issued through the operator's secret manager, not this file.
CREATE ROLE infrastructure_http LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT kode_infra_runtime TO infrastructure_http;
ALTER ROLE infrastructure_http SET search_path = pg_catalog;
CREATE ROLE infrastructure_operator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT kode_infra_provisioner TO infrastructure_operator;
ALTER ROLE infrastructure_operator SET search_path = pg_catalog;
-- In psql, use \password infrastructure_http and \password infrastructure_operator interactively.
-- Never grant either login membership in kode_infra_owner or any ordinary application role.
-- Audit all existing PUBLIC grants before claiming isolation; a dedicated auth DB is preferred.
