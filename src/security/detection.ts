/**
 * Phase 2 — behavioral detection over security.events windows.
 * Clients emit events; Kode correlates. No offensive actions.
 */
import { db } from '../db/pool.js';

export type BehavioralDetectorKind =
  | 'brute_force'
  | 'endpoint_enumeration'
  | 'authz_abuse'
  | 'rate_limit_abuse'
  | 'honeypot';

type DetectorConfig = {
  detector: BehavioralDetectorKind;
  windowSeconds: number;
  threshold: number;
  matchEventTypes: string[];
  createAlert: boolean;
  createIncident: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  ruleId: string;
  ruleName: string;
  description: string | null;
};

export function eventTypeMatches(eventType: string, patterns: string[]) {
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(eventType);
  });
}

async function loadBehavioralRules(organizationId: string): Promise<DetectorConfig[]> {
  const result = await db.query(
    `SELECT id, name, description, create_alert, create_incident, min_severity, metadata
     FROM security.detection_rules
     WHERE organization_id = $1
       AND enabled = TRUE
       AND metadata ? 'detector'`,
    [organizationId],
  );

  return result.rows
    .map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const detector = String(meta.detector ?? '') as BehavioralDetectorKind;
      if (
        ![
          'brute_force',
          'endpoint_enumeration',
          'authz_abuse',
          'rate_limit_abuse',
          'honeypot',
        ].includes(detector)
      ) {
        return null;
      }
      const matchEventTypes = Array.isArray(meta.match_event_types)
        ? meta.match_event_types.map(String)
        : [];
      if (!matchEventTypes.length) return null;

      return {
        detector,
        windowSeconds: Math.max(60, Number(meta.window_seconds ?? 300)),
        threshold: Math.max(2, Number(meta.threshold ?? 10)),
        matchEventTypes,
        createAlert: row.create_alert !== false,
        createIncident: Boolean(row.create_incident),
        severity: (['low', 'medium', 'high', 'critical'].includes(
          String(meta.alert_severity ?? row.min_severity),
        )
          ? String(meta.alert_severity ?? row.min_severity)
          : 'high') as DetectorConfig['severity'],
        ruleId: String(row.id),
        ruleName: String(row.name),
        description: (row.description as string | null) ?? null,
      } satisfies DetectorConfig;
    })
    .filter((row): row is DetectorConfig => row !== null);
}

async function countMatchingEvents(params: {
  organizationId: string;
  ipAddress: string;
  patterns: string[];
  windowSeconds: number;
}) {
  // ILIKE any of the patterns (support % wildcards).
  const likes = params.patterns.map((p) => p.replace(/\*/g, '%'));
  const result = await db.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT NULLIF(endpoint, ''))::int AS distinct_endpoints
     FROM security.events
     WHERE organization_id = $1
       AND ip_address = $2
       AND created_at >= NOW() - make_interval(secs => $3)
       AND (
         event_type = ANY($4::text[])
         OR event_type ILIKE ANY($5::text[])
       )`,
    [
      params.organizationId,
      params.ipAddress,
      params.windowSeconds,
      likes,
      likes,
    ],
  );
  return {
    total: Number(result.rows[0]?.total ?? 0),
    distinctEndpoints: Number(result.rows[0]?.distinct_endpoints ?? 0),
  };
}

async function recentOpenAlertExists(params: {
  organizationId: string;
  ruleId: string;
  ipAddress: string;
  windowSeconds: number;
}) {
  const result = await db.query(
    `SELECT id FROM security.alerts
     WHERE organization_id = $1
       AND status IN ('open', 'new', 'acknowledged', 'investigating')
       AND ip_address = $2
       AND created_at >= NOW() - make_interval(secs => $3)
       AND (metadata->>'rule_id') = $4
     LIMIT 1`,
    [
      params.organizationId,
      params.ipAddress,
      Math.max(params.windowSeconds, 600),
      params.ruleId,
    ],
  );
  return Boolean(result.rows[0]);
}

async function openAlertAndMaybeIncident(params: {
  organizationId: string;
  eventId: string;
  systemId: string | null;
  ipAddress: string;
  rule: DetectorConfig;
  eventCount: number;
  distinctEndpoints?: number;
}) {
  if (
    await recentOpenAlertExists({
      organizationId: params.organizationId,
      ruleId: params.rule.ruleId,
      ipAddress: params.ipAddress,
      windowSeconds: params.rule.windowSeconds,
    })
  ) {
    return { alertId: null, incidentId: null, suppressed: true };
  }

  let alertId: string | null = null;
  let incidentId: string | null = null;

  if (params.rule.createAlert) {
    const alert = await db.query(
      `INSERT INTO security.alerts (
         organization_id, event_id, system_id, ip_address, title, description,
         severity, status, first_seen_at, last_seen_at, event_count, rule_id, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'open',NOW(),NOW(),$8,$9,$10::jsonb
       )
       RETURNING id`,
      [
        params.organizationId,
        params.eventId,
        params.systemId,
        params.ipAddress,
        `${params.rule.ruleName} — observed source ${params.ipAddress}`,
        params.rule.description ??
          `Behavioral threshold crossed (${params.eventCount} matching events).`,
        params.rule.severity,
        params.eventCount,
        params.rule.ruleId,
        JSON.stringify({
          rule_id: params.rule.ruleId,
          rule_name: params.rule.ruleName,
          detector: params.rule.detector,
          event_count: params.eventCount,
          distinct_endpoints: params.distinctEndpoints ?? null,
          window_seconds: params.rule.windowSeconds,
          threshold: params.rule.threshold,
          auto: true,
          attribution: 'unknown',
          observed_source_note:
            'IP is an observed technical source, not proof of human identity.',
        }),
      ],
    );
    alertId = alert.rows[0]?.id as string;
  }

  if (params.rule.createIncident) {
    const incident = await db.query(
      `INSERT INTO security.incidents (
         organization_id, system_id, title, description, severity, status,
         related_ip_address, event_ids, first_seen_at, last_seen_at, admin_notes
       ) VALUES (
         $1,$2,$3,$4,$5,'investigating',$6,ARRAY[$7]::uuid[],NOW(),NOW(),$8
       )
       RETURNING id`,
      [
        params.organizationId,
        params.systemId,
        `Behavioral: ${params.rule.ruleName}`,
        `Opened by detector ${params.rule.detector} for observed source ${params.ipAddress}.`,
        params.rule.severity,
        params.ipAddress,
        params.eventId,
        `Rule: ${params.rule.ruleName}; count=${params.eventCount}`,
      ],
    );
    incidentId = incident.rows[0]?.id as string;

    if (alertId && incidentId) {
      await db.query(
        `UPDATE security.alerts SET incident_id = $2 WHERE id = $1`,
        [alertId, incidentId],
      );
    }

    await db.query(
      `INSERT INTO security.incident_events (incident_id, event_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [incidentId, params.eventId],
    );
  }

  return { alertId, incidentId, suppressed: false };
}

/**
 * Run after a security event is persisted.
 * Safe to call best-effort; failures should not break the request path.
 */
export async function runBehavioralDetection(params: {
  organizationId: string;
  eventId: string;
  eventType: string;
  ipAddress?: string | null;
  systemId?: string | null;
}) {
  if (!params.ipAddress) {
    return { evaluated: 0, alerts: [] as string[] };
  }

  const rules = await loadBehavioralRules(params.organizationId);
  const applicable = rules.filter((rule) =>
    eventTypeMatches(params.eventType, rule.matchEventTypes),
  );

  const openedAlerts: string[] = [];

  for (const rule of applicable) {
    const counts = await countMatchingEvents({
      organizationId: params.organizationId,
      ipAddress: params.ipAddress,
      patterns: rule.matchEventTypes,
      windowSeconds: rule.windowSeconds,
    });

    const metric =
      rule.detector === 'endpoint_enumeration'
        ? Math.max(counts.total, counts.distinctEndpoints)
        : counts.total;

    // Honeypot: any single match is enough (threshold usually 1).
    const crossed =
      rule.detector === 'honeypot'
        ? counts.total >= 1
        : metric >= rule.threshold;

    if (!crossed) continue;

    const result = await openAlertAndMaybeIncident({
      organizationId: params.organizationId,
      eventId: params.eventId,
      systemId: params.systemId ?? null,
      ipAddress: params.ipAddress,
      rule,
      eventCount: counts.total,
      distinctEndpoints: counts.distinctEndpoints,
    });

    if (result.alertId) openedAlerts.push(result.alertId);
  }

  return { evaluated: applicable.length, alerts: openedAlerts };
}
