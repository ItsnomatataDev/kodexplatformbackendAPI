-- Phase 2: behavioral detection rule seeds (windowed thresholds in metadata).

INSERT INTO security.detection_rules (
  organization_id,
  system_id,
  name,
  description,
  event_type_pattern,
  min_severity,
  min_risk_score,
  create_alert,
  create_incident,
  enabled,
  metadata
)
SELECT
  o.id,
  NULL,
  seed.name,
  seed.description,
  seed.event_type_pattern,
  seed.min_severity,
  seed.min_risk_score,
  seed.create_alert,
  seed.create_incident,
  TRUE,
  seed.metadata
FROM organizations.organizations o
CROSS JOIN (
  VALUES
    (
      'AUTH_BRUTE_FORCE',
      'Multiple authentication failures from one observed source within a short window.',
      'AUTH_FAILURE|%failed_login%|auth.login.failure',
      'high',
      0,
      TRUE,
      TRUE,
      '{"detector":"brute_force","window_seconds":300,"threshold":10,"alert_severity":"high","match_event_types":["AUTH_FAILURE","%failed_login%","auth.login.failure"]}'::jsonb
    ),
    (
      'ENDPOINT_ENUMERATION',
      'Many distinct or repeated sensitive/unknown endpoint hits from one observed source.',
      'ENDPOINT_ENUMERATION|%enumeration%|%404%',
      'high',
      0,
      TRUE,
      FALSE,
      '{"detector":"endpoint_enumeration","window_seconds":300,"threshold":25,"alert_severity":"high","match_event_types":["ENDPOINT_ENUMERATION","%enumeration%"]}'::jsonb
    ),
    (
      'AUTHZ_ABUSE',
      'Repeated authorization failures from one observed source.',
      'AUTHZ_FAILURE|%forbidden%|%permission%',
      'medium',
      0,
      TRUE,
      FALSE,
      '{"detector":"authz_abuse","window_seconds":600,"threshold":15,"alert_severity":"medium","match_event_types":["AUTHZ_FAILURE","%forbidden%","%permission%"]}'::jsonb
    ),
    (
      'RATE_LIMIT_ABUSE',
      'Repeated rate-limit violations from one observed source.',
      'RATE_LIMIT_VIOLATION|%rate_limit%',
      'high',
      0,
      TRUE,
      FALSE,
      '{"detector":"rate_limit_abuse","window_seconds":300,"threshold":8,"alert_severity":"high","match_event_types":["RATE_LIMIT_VIOLATION","%rate_limit%"]}'::jsonb
    ),
    (
      'HONEYPOT_TRIP',
      'Any interaction with an authorized honeypot / decoy endpoint.',
      'HONEYPOT_INTERACTION|%honeypot%',
      'critical',
      0,
      TRUE,
      TRUE,
      '{"detector":"honeypot","window_seconds":3600,"threshold":1,"alert_severity":"critical","match_event_types":["HONEYPOT_INTERACTION","%honeypot%"]}'::jsonb
    )
) AS seed(
  name,
  description,
  event_type_pattern,
  min_severity,
  min_risk_score,
  create_alert,
  create_incident,
  metadata
)
WHERE o.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM security.detection_rules r
    WHERE r.organization_id = o.id
      AND r.name = seed.name
      AND r.system_id IS NULL
  );
