-- REVIEW ONLY. Schedule daily using the controlled infrastructure owner/maintenance
-- channel AFTER approved encrypted export/retention policy. Never the HTTP/provisioner.
-- Removes attempts >1 day, denial aggregates >90 days, critical events >365 days,
-- expired challenges >1 day. Backups/exports must retain incident/legal holds separately.
BEGIN;
SET LOCAL ROLE kode_infra_owner;
SET LOCAL statement_timeout='60s';
SELECT infrastructure.retain_history();
COMMIT;
