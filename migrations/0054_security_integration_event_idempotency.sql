-- Integration ingest deduplicates on (integration_id, external_event_id).
-- Legacy system events stay on security_events_external_id_uq, which requires system_id.
CREATE UNIQUE INDEX IF NOT EXISTS security_events_integration_external_id_uq
    ON security.events (integration_id, external_event_id)
    WHERE integration_id IS NOT NULL
      AND external_event_id IS NOT NULL;
