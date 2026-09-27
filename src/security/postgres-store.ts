import { createHash, randomBytes } from 'node:crypto';
import { listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

function iso(v: unknown) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function hashIngestToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function mintIngestToken() {
  const raw = `kdesk_${randomBytes(24).toString('base64url')}`;
  return {
    token: raw,
    prefix: raw.slice(0, 12),
    hash: hashIngestToken(raw),
  };
}

function matchesEventPattern(eventType: string, pattern: string) {
  const parts = pattern
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return true;
  return parts.some((part) => {
    const escaped = part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(eventType);
  });
}

function mapSystem(row: Record<string, unknown>) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    kind: row.kind,
    environment: row.environment,
    base_url: row.base_url ?? null,
    status: row.status,
    health_status: row.health_status,
    last_heartbeat_at: iso(row.last_heartbeat_at),
    last_event_at: iso(row.last_event_at),
    open_alert_count: Number(row.open_alert_count ?? 0),
    open_incident_count: Number(row.open_incident_count ?? 0),
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export class PostgresSecurityStore {
  async summary(organizationId: string) {
    const [events, alerts, blocklist, incidents] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE risk_score >= 80)::int AS high_risk,
                count(*) FILTER (WHERE event_type ILIKE '%failed_login%')::int AS failed_logins,
                count(*) FILTER (WHERE event_type ILIKE '%organization_access_denied%')::int AS org_denials,
                count(*) FILTER (WHERE event_type ILIKE '%prompt_injection%' OR event_type ILIKE '%ai_%')::int AS ai_abuse
         FROM security.events WHERE organization_id = $1`,
        [organizationId],
      ),
      db.query(`SELECT count(*)::int AS open FROM security.alerts WHERE organization_id = $1 AND status = 'open'`, [organizationId]),
      db.query(`SELECT count(*)::int AS blocked FROM security.blocklist WHERE organization_id = $1 AND unblocked_at IS NULL`, [organizationId]),
      db.query(`SELECT count(*)::int AS open FROM security.incidents WHERE organization_id = $1 AND status <> 'resolved'`, [organizationId]),
    ]);
    const e = events.rows[0];
    return {
      total_events: e.total,
      high_risk_events: e.high_risk,
      blocked_ips: blocklist.rows[0].blocked,
      failed_logins: e.failed_logins,
      organization_access_denials: e.org_denials,
      ai_abuse_attempts: e.ai_abuse,
      open_alerts: alerts.rows[0].open,
      open_incidents: incidents.rows[0].open,
    };
  }

  async listEvents(
    organizationId: string,
    options: { limit?: number; systemId?: string | null } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const result = await db.query(
      `SELECT e.*, p.full_name, u.email,
              ms.slug AS system_slug, ms.name AS system_name
       FROM security.events e
       LEFT JOIN identity.user_profiles p ON p.user_id = e.user_id
       LEFT JOIN identity.users u ON u.id = e.user_id
       LEFT JOIN security.monitored_systems ms ON ms.id = e.system_id
       WHERE e.organization_id = $1
         AND ($2::uuid IS NULL OR e.system_id = $2)
       ORDER BY e.created_at DESC
       LIMIT $3`,
      [organizationId, options.systemId ?? null, limit],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      enriched_at: iso(row.enriched_at),
      location_captured_at: iso(row.location_captured_at),
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      system_slug: row.system_slug ?? null,
      system_name: row.system_name ?? null,
      metadata: row.metadata ?? {},
    }));
  }

  async listAlerts(
    organizationId: string,
    options: { systemId?: string | null } = {},
  ) {
    const result = await db.query(
      `SELECT a.*, ms.slug AS system_slug, ms.name AS system_name
       FROM security.alerts a
       LEFT JOIN security.monitored_systems ms ON ms.id = a.system_id
       WHERE a.organization_id = $1
         AND ($2::uuid IS NULL OR a.system_id = $2)
       ORDER BY a.created_at DESC LIMIT 100`,
      [organizationId, options.systemId ?? null],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      resolved_at: iso(row.resolved_at),
      system_slug: row.system_slug ?? null,
      system_name: row.system_name ?? null,
    }));
  }

  async listIncidents(
    organizationId: string,
    options: { systemId?: string | null } = {},
  ) {
    const result = await db.query(
      `SELECT i.*, ms.slug AS system_slug, ms.name AS system_name
       FROM security.incidents i
       LEFT JOIN security.monitored_systems ms ON ms.id = i.system_id
       WHERE i.organization_id = $1
         AND ($2::uuid IS NULL OR i.system_id = $2)
       ORDER BY i.created_at DESC LIMIT 100`,
      [organizationId, options.systemId ?? null],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      resolved_at: iso(row.resolved_at),
      event_ids: row.event_ids ?? [],
      system_slug: row.system_slug ?? null,
      system_name: row.system_name ?? null,
    }));
  }

  async listMonitoredSystems(organizationId: string) {
    const result = await db.query(
      `SELECT * FROM security.monitored_systems
       WHERE organization_id = $1
       ORDER BY
         CASE kind
           WHEN 'platform' THEN 0
           WHEN 'product' THEN 1
           WHEN 'infrastructure' THEN 2
           ELSE 3
         END,
         name ASC`,
      [organizationId],
    );
    return result.rows.map((row) => mapSystem(row as Record<string, unknown>));
  }

  async getMonitoredSystem(organizationId: string, systemId: string) {
    const result = await db.query(
      `SELECT * FROM security.monitored_systems
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, systemId],
    );
    return result.rows[0]
      ? mapSystem(result.rows[0] as Record<string, unknown>)
      : null;
  }

  async createMonitoredSystem(
    organizationId: string,
    input: {
      slug: string;
      name: string;
      description?: string | null;
      kind?: string;
      environment?: string;
      baseUrl?: string | null;
      metadata?: Record<string, unknown>;
    },
    createdBy?: string | null,
  ) {
    const slug = input.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) throw new ValidationError('slug is required.');
    const result = await db.query(
      `INSERT INTO security.monitored_systems (
         organization_id, slug, name, description, kind, environment, base_url, metadata
       ) VALUES ($1,$2,$3,$4,COALESCE($5,'external'),COALESCE($6,'production'),$7,COALESCE($8,'{}'::jsonb))
       RETURNING *`,
      [
        organizationId,
        slug,
        input.name.trim(),
        input.description ?? null,
        input.kind ?? 'external',
        input.environment ?? 'production',
        input.baseUrl ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const system = mapSystem(result.rows[0] as Record<string, unknown>);
    const token = await this.rotateIngestToken(
      organizationId,
      system.id as string,
      createdBy ?? null,
      'default',
    );
    return { system, ingestToken: token.token, tokenPrefix: token.prefix };
  }

  async updateMonitoredSystem(
    organizationId: string,
    systemId: string,
    patch: Record<string, unknown>,
  ) {
    const result = await db.query(
      `UPDATE security.monitored_systems
       SET name = COALESCE($3, name),
           description = COALESCE($4, description),
           kind = COALESCE($5, kind),
           environment = COALESCE($6, environment),
           base_url = COALESCE($7, base_url),
           status = COALESCE($8, status),
           health_status = COALESCE($9, health_status),
           metadata = CASE
             WHEN $10::jsonb IS NULL THEN metadata
             ELSE metadata || $10::jsonb
           END,
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        systemId,
        typeof patch.name === 'string' ? patch.name : null,
        typeof patch.description === 'string' ? patch.description : null,
        typeof patch.kind === 'string' ? patch.kind : null,
        typeof patch.environment === 'string' ? patch.environment : null,
        typeof patch.base_url === 'string' || typeof patch.baseUrl === 'string'
          ? (patch.base_url ?? patch.baseUrl)
          : null,
        typeof patch.status === 'string' ? patch.status : null,
        typeof patch.health_status === 'string' ||
        typeof patch.healthStatus === 'string'
          ? (patch.health_status ?? patch.healthStatus)
          : null,
        patch.metadata && typeof patch.metadata === 'object'
          ? JSON.stringify(patch.metadata)
          : null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('SYSTEM_NOT_FOUND', 'Monitored system not found.');
    }
    return mapSystem(result.rows[0] as Record<string, unknown>);
  }

  async rotateIngestToken(
    organizationId: string,
    systemId: string,
    createdBy: string | null,
    label = 'default',
  ) {
    const system = await this.getMonitoredSystem(organizationId, systemId);
    if (!system) {
      throw new NotFoundError('SYSTEM_NOT_FOUND', 'Monitored system not found.');
    }
    await db.query(
      `UPDATE security.ingest_tokens
       SET revoked_at = NOW()
       WHERE organization_id = $1 AND system_id = $2 AND revoked_at IS NULL`,
      [organizationId, systemId],
    );
    const minted = mintIngestToken();
    await db.query(
      `INSERT INTO security.ingest_tokens (
         organization_id, system_id, token_prefix, token_hash, label, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        organizationId,
        systemId,
        minted.prefix,
        minted.hash,
        label,
        createdBy,
      ],
    );
    return { token: minted.token, prefix: minted.prefix };
  }

  async resolveIngestToken(rawToken: string) {
    const hash = hashIngestToken(rawToken.trim());
    const result = await db.query(
      `SELECT t.id AS token_id, t.system_id, t.organization_id,
              s.slug, s.name, s.status
       FROM security.ingest_tokens t
       JOIN security.monitored_systems s ON s.id = t.system_id
       WHERE t.token_hash = $1 AND t.revoked_at IS NULL
       LIMIT 1`,
      [hash],
    );
    return result.rows[0] ?? null;
  }

  async deskSummary(organizationId: string) {
    const [systems, openBySystem, recentAttacks] = await Promise.all([
      this.listMonitoredSystems(organizationId),
      db.query(
        `SELECT system_id,
                count(*) FILTER (WHERE status = 'open')::int AS open_alerts,
                count(*) FILTER (
                  WHERE status = 'open' AND severity IN ('high','critical')
                )::int AS criticalish
         FROM security.alerts
         WHERE organization_id = $1 AND system_id IS NOT NULL
         GROUP BY system_id`,
        [organizationId],
      ),
      db.query(
        `SELECT e.id, e.event_type, e.severity, e.risk_score, e.attack_category,
                e.created_at, e.system_id, ms.slug AS system_slug, ms.name AS system_name
         FROM security.events e
         LEFT JOIN security.monitored_systems ms ON ms.id = e.system_id
         WHERE e.organization_id = $1
           AND (
             e.severity IN ('high','critical')
             OR e.risk_score >= 70
             OR e.attack_category IS NOT NULL
           )
         ORDER BY e.created_at DESC
         LIMIT 40`,
        [organizationId],
      ),
    ]);

    const alertMap = new Map(
      openBySystem.rows.map((row) => [
        row.system_id as string,
        {
          open_alerts: Number(row.open_alerts ?? 0),
          criticalish: Number(row.criticalish ?? 0),
        },
      ]),
    );

    return {
      systems: systems.map((system) => {
        const counts = alertMap.get(system.id as string);
        return {
          ...system,
          open_alerts: counts?.open_alerts ?? system.open_alert_count,
          high_open_alerts: counts?.criticalish ?? 0,
        };
      }),
      recent_attacks: recentAttacks.rows.map((row) => ({
        id: row.id,
        event_type: row.event_type,
        severity: row.severity,
        risk_score: Number(row.risk_score ?? 0),
        attack_category: row.attack_category ?? null,
        system_id: row.system_id ?? null,
        system_slug: row.system_slug ?? null,
        system_name: row.system_name ?? null,
        created_at: iso(row.created_at),
      })),
      totals: {
        systems: systems.length,
        active: systems.filter((s) => s.status === 'active').length,
        critical_health: systems.filter((s) => s.health_status === 'critical')
          .length,
        open_alerts: systems.reduce(
          (sum, s) => sum + Number(s.open_alert_count ?? 0),
          0,
        ),
        open_incidents: systems.reduce(
          (sum, s) => sum + Number(s.open_incident_count ?? 0),
          0,
        ),
      },
    };
  }

  async refreshSystemCounters(organizationId: string, systemId: string) {
    await db.query(
      `UPDATE security.monitored_systems s
       SET open_alert_count = (
             SELECT count(*)::int FROM security.alerts a
             WHERE a.organization_id = s.organization_id
               AND a.system_id = s.id AND a.status = 'open'
           ),
           open_incident_count = (
             SELECT count(*)::int FROM security.incidents i
             WHERE i.organization_id = s.organization_id
               AND i.system_id = s.id AND i.status <> 'resolved'
           ),
           updated_at = NOW()
       WHERE s.organization_id = $1 AND s.id = $2`,
      [organizationId, systemId],
    );
  }

  async evaluateDetectionRules(params: {
    organizationId: string;
    systemId: string | null;
    eventId: string;
    eventType: string;
    severity: string;
    riskScore: number;
    attackCategory?: string | null;
    titleHint?: string | null;
  }) {
    const rules = await db.query(
      `SELECT * FROM security.detection_rules
       WHERE organization_id = $1
         AND enabled = TRUE
         AND (system_id IS NULL OR system_id = $2)`,
      [params.organizationId, params.systemId],
    );

    const severityRank = SEVERITY_RANK[params.severity] ?? 1;
    let alertId: string | null = null;
    let incidentId: string | null = null;

    for (const rule of rules.rows) {
      if (!matchesEventPattern(params.eventType, String(rule.event_type_pattern))) {
        continue;
      }
      const minSeverity = String(rule.min_severity ?? 'medium');
      const minRank = SEVERITY_RANK[minSeverity] ?? 2;
      if (severityRank < minRank && params.riskScore < Number(rule.min_risk_score ?? 0)) {
        continue;
      }

      if (rule.create_alert) {
        const alert = await db.query(
          `INSERT INTO security.alerts (
             organization_id, event_id, system_id, title, description,
             severity, status, attack_category, metadata
           ) VALUES (
             $1,$2,$3,$4,$5,
             CASE WHEN $6 IN ('info','low') THEN 'low' ELSE $6 END,
             'open',$7,$8::jsonb
           )
           RETURNING id`,
          [
            params.organizationId,
            params.eventId,
            params.systemId,
            `${rule.name}: ${params.eventType}`,
            rule.description ?? params.titleHint ?? null,
            params.severity === 'info' ? 'low' : params.severity,
            params.attackCategory ?? null,
            JSON.stringify({
              rule_id: rule.id,
              rule_name: rule.name,
              auto: true,
            }),
          ],
        );
        alertId = alert.rows[0]?.id as string;
      }

      if (rule.create_incident) {
        const incident = await db.query(
          `INSERT INTO security.incidents (
             organization_id, system_id, title, description, severity, status,
             event_ids, attack_category, admin_notes
           ) VALUES (
             $1,$2,$3,$4,
             CASE WHEN $5 IN ('info','low') THEN 'low' ELSE $5 END,
             'open', ARRAY[$6]::uuid[], $7, $8
           )
           RETURNING id`,
          [
            params.organizationId,
            params.systemId,
            `Auto-incident: ${params.eventType}`,
            rule.description ?? 'Opened by cyber desk detection rule.',
            params.severity === 'info' ? 'low' : params.severity,
            params.eventId,
            params.attackCategory ?? null,
            `Rule: ${rule.name}`,
          ],
        );
        incidentId = incident.rows[0]?.id as string;
      }
    }

    if (params.systemId) {
      await this.refreshSystemCounters(params.organizationId, params.systemId);
    }

    return { alertId, incidentId };
  }

  async ingestExternalEvent(params: {
    organizationId: string;
    systemId: string;
    tokenId: string;
    input: {
      eventType: string;
      severity?: string;
      riskScore?: number;
      successful?: boolean;
      ipAddress?: string | null;
      endpoint?: string | null;
      attackCategory?: string | null;
      externalEventId?: string | null;
      title?: string | null;
      description?: string | null;
      metadata?: Record<string, unknown>;
      healthStatus?: string | null;
      heartbeat?: boolean;
    };
  }) {
    const severity = params.input.severity ?? 'medium';
    const riskScore = Math.max(0, Number(params.input.riskScore ?? 0));

    if (params.input.heartbeat || params.input.healthStatus) {
      await db.query(
        `UPDATE security.monitored_systems
         SET last_heartbeat_at = NOW(),
             health_status = COALESCE($3, health_status),
             updated_at = NOW()
         WHERE organization_id = $1 AND id = $2`,
        [
          params.organizationId,
          params.systemId,
          params.input.healthStatus ?? null,
        ],
      );
      if (params.input.heartbeat && !params.input.eventType) {
        await db.query(
          `UPDATE security.ingest_tokens SET last_used_at = NOW() WHERE id = $1`,
          [params.tokenId],
        );
        return { heartbeat: true };
      }
    }

    const inserted = await db.query(
      `INSERT INTO security.events (
         organization_id, system_id, ip_address, endpoint, event_type, severity,
         risk_score, successful, attack_category, external_event_id, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,COALESCE($6,'medium'),COALESCE($7,0),COALESCE($8,false),$9,$10,COALESCE($11,'{}'::jsonb)
       )
       ON CONFLICT (organization_id, system_id, external_event_id)
         WHERE external_event_id IS NOT NULL AND system_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        params.organizationId,
        params.systemId,
        params.input.ipAddress ?? null,
        params.input.endpoint ?? null,
        params.input.eventType,
        severity,
        riskScore,
        params.input.successful ?? false,
        params.input.attackCategory ?? null,
        params.input.externalEventId ?? null,
        JSON.stringify({
          ...((await import('./recorder.js')).scrubSecurityMetadata(
            params.input.metadata ?? {},
          )),
          title: params.input.title ?? null,
          description: params.input.description ?? null,
          source: 'ingest',
        }),
      ],
    );

    await db.query(
      `UPDATE security.ingest_tokens SET last_used_at = NOW() WHERE id = $1`,
      [params.tokenId],
    );
    await db.query(
      `UPDATE security.monitored_systems
       SET last_event_at = NOW(),
           health_status = CASE
             WHEN $3 IN ('critical','high') THEN 'critical'
             WHEN $3 = 'medium' AND health_status IN ('unknown','healthy') THEN 'degraded'
             ELSE health_status
           END,
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2`,
      [params.organizationId, params.systemId, severity],
    );

    const eventId = inserted.rows[0]?.id as string | undefined;
    if (!eventId) {
      return { duplicate: true };
    }

    const detection = await this.evaluateDetectionRules({
      organizationId: params.organizationId,
      systemId: params.systemId,
      eventId,
      eventType: params.input.eventType,
      severity,
      riskScore,
      attackCategory: params.input.attackCategory ?? null,
      titleHint: params.input.title ?? params.input.description ?? null,
    });

    let behavioral: { alerts: string[] } = { alerts: [] };
    try {
      const { runBehavioralDetection } = await import('./detection.js');
      behavioral = await runBehavioralDetection({
        organizationId: params.organizationId,
        eventId,
        eventType: params.input.eventType,
        ipAddress: params.input.ipAddress ?? null,
        systemId: params.systemId,
      });
    } catch {
      // Behavioral detection is best-effort.
    }

    return { eventId, ...detection, behavioralAlerts: behavioral.alerts };
  }

  async listBlocklist(organizationId: string, requestedLimit?: number) {
    const limit = listLimit(requestedLimit);
    const result = await db.query(
      `SELECT * FROM security.blocklist
       WHERE organization_id = $1
       ORDER BY blocked_at DESC, id DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      ...row,
      blocked_at: iso(row.blocked_at),
      expires_at: iso(row.expires_at),
      unblocked_at: iso(row.unblocked_at),
    }));
  }

  async listSessions(organizationId: string) {
    const result = await db.query(
      `SELECT s.*, p.full_name, u.email,
              CASE WHEN s.risk_score >= 120 THEN 'critical'
                   WHEN s.risk_score >= 80 THEN 'high'
                   WHEN s.risk_score >= 50 THEN 'suspicious'
                   WHEN s.risk_score >= 25 THEN 'watch'
                   ELSE 'normal' END AS risk_level
       FROM security.sessions s
       LEFT JOIN identity.user_profiles p ON p.user_id = s.user_id
       LEFT JOIN identity.users u ON u.id = s.user_id
       WHERE s.organization_id = $1
       ORDER BY s.last_seen_at DESC
       LIMIT 200`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      ...row,
      started_at: iso(row.started_at),
      last_seen_at: iso(row.last_seen_at),
      ended_at: iso(row.ended_at),
      location_captured_at: iso(row.location_captured_at),
      full_name: row.full_name ?? null,
      email: row.email ?? null,
    }));
  }

  async listDevices(organizationId: string) {
    const result = await db.query(
      `SELECT * FROM security.devices WHERE organization_id = $1 ORDER BY last_seen_at DESC LIMIT 200`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      ...row,
      first_seen_at: iso(row.first_seen_at),
      last_seen_at: iso(row.last_seen_at),
      fingerprint_hash: row.fingerprint_hash,
    }));
  }

  async listLoginVerifications(organizationId: string) {
    const result = await db.query(
      `SELECT v.*, p.full_name, u.email
       FROM security.login_verifications v
       LEFT JOIN identity.user_profiles p ON p.user_id = v.user_id
       LEFT JOIN identity.users u ON u.id = v.user_id
       WHERE v.organization_id = $1
       ORDER BY v.created_at DESC
       LIMIT 100`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      reviewed_at: iso(row.reviewed_at),
      email: row.email ?? '',
      full_name: row.full_name ?? null,
      risk_signals: row.risk_signals ?? [],
    }));
  }

  async createIncident(organizationId: string, createdBy: string, input: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO security.incidents (
         organization_id, system_id, title, description, severity, status, related_user_id,
         related_ip_address, event_ids, admin_notes, attack_category, created_by
       ) VALUES ($1,$2,$3,$4,COALESCE($5,'medium'),'open',$6,$7,COALESCE($8,'{}'),$9,$10,$11)
       RETURNING *`,
      [
        organizationId,
        input.system_id ?? input.systemId ?? null,
        input.title,
        input.description ?? null,
        input.severity ?? 'medium',
        input.related_user_id ?? input.relatedUserId ?? null,
        input.related_ip_address ?? input.relatedIpAddress ?? null,
        input.event_ids ?? input.eventIds ?? [],
        input.admin_notes ?? input.adminNotes ?? null,
        input.attack_category ?? input.attackCategory ?? null,
        createdBy,
      ],
    );
    const systemId = (input.system_id ?? input.systemId) as string | undefined;
    if (systemId) {
      await this.refreshSystemCounters(organizationId, systemId);
    }
    return result.rows[0];
  }

  async updateIncident(organizationId: string, incidentId: string, patch: Record<string, unknown>, actorId: string) {
    const result = await db.query(
      `UPDATE security.incidents
       SET title = COALESCE($3, title),
           description = COALESCE($4, description),
           severity = COALESCE($5, severity),
           status = COALESCE($6, status),
           admin_notes = COALESCE($7, admin_notes),
           resolved_by = CASE WHEN $6 = 'resolved' THEN $8 ELSE resolved_by END,
           resolved_at = CASE WHEN $6 = 'resolved' THEN NOW() ELSE resolved_at END,
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        incidentId,
        patch.title ?? null,
        patch.description ?? null,
        patch.severity ?? null,
        patch.status ?? null,
        patch.admin_notes ?? patch.adminNotes ?? null,
        actorId,
      ],
    );
    if (!result.rows[0]) throw new NotFoundError('INCIDENT_NOT_FOUND', 'Incident not found.');
    return result.rows[0];
  }

  async enrichIp(organizationId: string, ipAddress: string, enrichment: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO security.ip_reputation (
         organization_id, ip_address, country, city, region, latitude, longitude,
         timezone, isp, asn, enriched_at, risk_score, total_events, failed_logins
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),COALESCE($11,0),COALESCE($12,0),COALESCE($13,0))
       ON CONFLICT (organization_id, ip_address) DO UPDATE SET
         country = COALESCE(EXCLUDED.country, security.ip_reputation.country),
         city = COALESCE(EXCLUDED.city, security.ip_reputation.city),
         region = COALESCE(EXCLUDED.region, security.ip_reputation.region),
         latitude = COALESCE(EXCLUDED.latitude, security.ip_reputation.latitude),
         longitude = COALESCE(EXCLUDED.longitude, security.ip_reputation.longitude),
         timezone = COALESCE(EXCLUDED.timezone, security.ip_reputation.timezone),
         isp = COALESCE(EXCLUDED.isp, security.ip_reputation.isp),
         asn = COALESCE(EXCLUDED.asn, security.ip_reputation.asn),
         enriched_at = NOW(),
         last_seen_at = NOW()
       RETURNING *`,
      [
        organizationId,
        ipAddress,
        enrichment.country ?? null,
        enrichment.city ?? null,
        enrichment.region ?? null,
        enrichment.latitude ?? null,
        enrichment.longitude ?? null,
        enrichment.timezone ?? null,
        enrichment.isp ?? null,
        enrichment.asn ?? null,
        enrichment.risk_score ?? 0,
        enrichment.total_events ?? 0,
        enrichment.failed_logins ?? 0,
      ],
    );
    await db.query(
      `UPDATE security.events
       SET country = COALESCE($3, country),
           city = COALESCE($4, city),
           region = COALESCE($5, region),
           latitude = COALESCE($6, latitude),
           longitude = COALESCE($7, longitude),
           timezone = COALESCE($8, timezone),
           isp = COALESCE($9, isp),
           asn = COALESCE($10, asn),
           enriched_at = NOW()
       WHERE organization_id = $1 AND ip_address = $2 AND enriched_at IS NULL`,
      [
        organizationId,
        ipAddress,
        enrichment.country ?? null,
        enrichment.city ?? null,
        enrichment.region ?? null,
        enrichment.latitude ?? null,
        enrichment.longitude ?? null,
        enrichment.timezone ?? null,
        enrichment.isp ?? null,
        enrichment.asn ?? null,
      ],
    );
    return result.rows[0];
  }

  async listHighRiskIps(organizationId: string) {
    const result = await db.query(
      `SELECT r.*,
              EXISTS (
                SELECT 1 FROM security.blocklist b
                WHERE b.organization_id = r.organization_id
                  AND b.target_type = 'ip'
                  AND b.target_value = r.ip_address
                  AND b.unblocked_at IS NULL
              ) AS blocked
       FROM security.ip_reputation r
       WHERE r.organization_id = $1
       ORDER BY r.risk_score DESC, r.last_seen_at DESC
       LIMIT 100`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      ...row,
      first_seen_at: iso(row.first_seen_at),
      last_seen_at: iso(row.last_seen_at),
      enriched_at: iso(row.enriched_at),
      blocked: Boolean(row.blocked),
    }));
  }

  async listHighRiskUsers(
    organizationId: string,
    options: { since?: string | Date | null; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const since =
      options.since instanceof Date
        ? options.since
        : options.since
          ? new Date(options.since)
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(since.getTime())) {
      return [];
    }

    const result = await db.query(
      `SELECT
         e.user_id,
         COALESCE(NULLIF(p.full_name, ''), 'Unknown user') AS full_name,
         u.email,
         COALESCE(SUM(e.risk_score), 0)::int AS risk_score,
         COUNT(*)::int AS recent_events,
         (ARRAY_AGG(e.ip_address ORDER BY e.created_at DESC)
           FILTER (WHERE e.ip_address IS NOT NULL))[1] AS last_ip,
         (ARRAY_AGG(e.device ORDER BY e.created_at DESC)
           FILTER (WHERE e.device IS NOT NULL))[1] AS last_device,
         MAX(e.created_at) AS last_seen_at
       FROM security.events e
       LEFT JOIN identity.user_profiles p ON p.user_id = e.user_id
       LEFT JOIN identity.users u ON u.id = e.user_id
       WHERE e.organization_id = $1
         AND e.created_at >= $2
         AND e.user_id IS NOT NULL
       GROUP BY e.user_id, p.full_name, u.email
       ORDER BY SUM(e.risk_score) DESC, MAX(e.created_at) DESC
       LIMIT $3`,
      [organizationId, since.toISOString(), limit],
    );

    return result.rows.map((row) => ({
      user_id: row.user_id as string,
      full_name: (row.full_name as string) ?? 'Unknown user',
      email: (row.email as string) ?? '',
      risk_score: Number(row.risk_score ?? 0),
      recent_events: Number(row.recent_events ?? 0),
      last_ip: (row.last_ip as string | null) ?? null,
      last_device: (row.last_device as string | null) ?? null,
      last_seen_at: iso(row.last_seen_at)!,
    }));
  }

  async blockIp(
    organizationId: string,
    actorId: string,
    ipAddress: string,
    reason: string,
    expiresAt: string | null = null,
  ) {
    const existing = await db.query(
      `SELECT id FROM security.blocklist
       WHERE organization_id = $1
         AND target_type = 'ip'
         AND lower(target_value) = lower($2)
         AND unblocked_at IS NULL
       LIMIT 1`,
      [organizationId, ipAddress.trim()],
    );
    if (existing.rows[0]) {
      const updated = await db.query(
        `UPDATE security.blocklist
         SET reason = $2,
             blocked_by = $3,
             blocked_at = NOW(),
             expires_at = $4
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id, reason, actorId, expiresAt],
      );
      return {
        ...updated.rows[0],
        blocked_at: iso(updated.rows[0].blocked_at),
        expires_at: iso(updated.rows[0].expires_at),
        unblocked_at: iso(updated.rows[0].unblocked_at),
      };
    }

    const result = await db.query(
      `INSERT INTO security.blocklist (
         organization_id, target_type, target_value, reason, blocked_by, expires_at
       ) VALUES ($1, 'ip', $2, $3, $4, $5)
       RETURNING *`,
      [organizationId, ipAddress.trim(), reason, actorId, expiresAt],
    );
    return {
      ...result.rows[0],
      blocked_at: iso(result.rows[0].blocked_at),
      expires_at: iso(result.rows[0].expires_at),
      unblocked_at: iso(result.rows[0].unblocked_at),
    };
  }

  async unblockIp(organizationId: string, actorId: string, ipAddress: string) {
    const result = await db.query(
      `UPDATE security.blocklist
       SET unblocked_at = NOW(), unblocked_by = $3
       WHERE organization_id = $1
         AND target_type = 'ip'
         AND lower(target_value) = lower($2)
         AND unblocked_at IS NULL
       RETURNING *`,
      [organizationId, ipAddress.trim(), actorId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('BLOCKLIST_ENTRY_NOT_FOUND', 'Active IP block not found.');
    }
    return {
      ...result.rows[0],
      blocked_at: iso(result.rows[0].blocked_at),
      expires_at: iso(result.rows[0].expires_at),
      unblocked_at: iso(result.rows[0].unblocked_at),
    };
  }

  async resolveAlert(
    organizationId: string,
    alertId: string,
    actorId: string,
    notes: string,
  ) {
    const result = await db.query(
      `UPDATE security.alerts
       SET status = 'resolved',
           resolved_by = $3,
           resolved_at = NOW(),
           resolution_notes = $4
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [organizationId, alertId, actorId, notes],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('ALERT_NOT_FOUND', 'Alert not found.');
    }
    return {
      ...result.rows[0],
      created_at: iso(result.rows[0].created_at),
      resolved_at: iso(result.rows[0].resolved_at),
    };
  }

  async reviewLoginVerification(
    organizationId: string,
    verificationId: string,
    decision: 'approved' | 'rejected',
    notes: string,
  ) {
    const status = decision === 'approved' ? 'approved' : 'rejected';
    const result = await db.query(
      `UPDATE security.login_verifications
       SET status = $3,
           reviewed_at = NOW(),
           review_notes = $4
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [organizationId, verificationId, status, notes],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'LOGIN_VERIFICATION_NOT_FOUND',
        'Login verification not found.',
      );
    }
    return {
      ...result.rows[0],
      created_at: iso(result.rows[0].created_at),
      reviewed_at: iso(result.rows[0].reviewed_at),
      risk_signals: result.rows[0].risk_signals ?? [],
    };
  }

  async logEvent(
    organizationId: string,
    input: {
      userId?: string | null;
      sessionId?: string | null;
      systemId?: string | null;
      eventType: string;
      severity?: string;
      riskScore?: number;
      successful?: boolean;
      ipAddress?: string | null;
      country?: string | null;
      city?: string | null;
      userAgent?: string | null;
      browser?: string | null;
      os?: string | null;
      device?: string | null;
      requestMethod?: string | null;
      endpoint?: string | null;
      attackCategory?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const result = await db.query(
      `INSERT INTO security.events (
         organization_id, user_id, session_id, system_id, ip_address, country, city,
         user_agent, browser, os, device, request_method, endpoint,
         event_type, severity, risk_score, successful, attack_category, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,'low'),COALESCE($16,0),COALESCE($17,false),$18,COALESCE($19,'{}'::jsonb)
       )
       RETURNING id`,
      [
        organizationId,
        input.userId ?? null,
        input.sessionId ?? null,
        input.systemId ?? null,
        input.ipAddress ?? null,
        input.country ?? null,
        input.city ?? null,
        input.userAgent ?? null,
        input.browser ?? null,
        input.os ?? null,
        input.device ?? null,
        input.requestMethod ?? null,
        input.endpoint ?? null,
        input.eventType,
        input.severity ?? 'low',
        input.riskScore ?? 0,
        input.successful ?? false,
        input.attackCategory ?? null,
        JSON.stringify(
          (await import('./recorder.js')).scrubSecurityMetadata(input.metadata),
        ),
      ],
    );
    const eventId = result.rows[0]?.id as string;
    if (input.systemId) {
      await db.query(
        `UPDATE security.monitored_systems
         SET last_event_at = NOW(), updated_at = NOW()
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, input.systemId],
      );
      await this.evaluateDetectionRules({
        organizationId,
        systemId: input.systemId,
        eventId,
        eventType: input.eventType,
        severity: input.severity ?? 'low',
        riskScore: input.riskScore ?? 0,
        attackCategory: input.attackCategory ?? null,
      });
    }

    try {
      const { runBehavioralDetection } = await import('./detection.js');
      await runBehavioralDetection({
        organizationId,
        eventId,
        eventType: input.eventType,
        ipAddress: input.ipAddress ?? null,
        systemId: input.systemId ?? null,
      });
    } catch {
      // best-effort
    }

    return eventId;
  }

  async recordPreciseLocation(
    organizationId: string,
    userId: string,
    latitude: number,
    longitude: number,
    accuracyMeters: number | null,
    capturedAt: string,
  ) {
    await db.query(
      `UPDATE security.sessions
       SET precise_latitude = $3,
           precise_longitude = $4,
           location_accuracy_meters = $5,
           location_permission_granted = TRUE,
           location_captured_at = $6::timestamptz,
           location_source = 'gps'
       WHERE organization_id = $1
         AND user_id = $2
         AND ended_at IS NULL`,
      [organizationId, userId, latitude, longitude, accuracyMeters, capturedAt],
    );
  }

  async getLoginVerification(organizationId: string, verificationId: string) {
    const result = await db.query(
      `SELECT v.*, p.full_name, u.email
       FROM security.login_verifications v
       LEFT JOIN identity.user_profiles p ON p.user_id = v.user_id
       LEFT JOIN identity.users u ON u.id = v.user_id
       WHERE v.organization_id = $1 AND v.id = $2`,
      [organizationId, verificationId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'LOGIN_VERIFICATION_NOT_FOUND',
        'Login verification not found.',
      );
    }
    const row = result.rows[0];
    return {
      ...row,
      created_at: iso(row.created_at),
      reviewed_at: iso(row.reviewed_at),
      email: row.email ?? '',
      full_name: row.full_name ?? null,
      risk_signals: row.risk_signals ?? [],
    };
  }

  async updateLoginVerificationLocation(
    organizationId: string,
    verificationId: string,
    patch: {
      granted: boolean;
      latitude?: number | null;
      longitude?: number | null;
      accuracyMeters?: number | null;
      status?: string;
    },
  ) {
    const result = await db.query(
      `UPDATE security.login_verifications
       SET location_permission_granted = $3,
           approximate_latitude = COALESCE($4, approximate_latitude),
           approximate_longitude = COALESCE($5, approximate_longitude),
           location_accuracy_meters = COALESCE($6, location_accuracy_meters),
           location_source = CASE WHEN $3 THEN 'gps' ELSE location_source END,
           status = COALESCE($7, status)
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        verificationId,
        patch.granted,
        patch.latitude ?? null,
        patch.longitude ?? null,
        patch.accuracyMeters ?? null,
        patch.status ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'LOGIN_VERIFICATION_NOT_FOUND',
        'Login verification not found.',
      );
    }
    return result.rows[0];
  }

  // ---------------------------------------------------------------------------
  // Security Control Center (Phase 1)
  // ---------------------------------------------------------------------------

  async controlCenterSummary(organizationId: string) {
    const [window24h, open, assets, recent, topIps] = await Promise.all([
      db.query(
        `SELECT
           count(*)::int AS events_24h,
           count(*) FILTER (WHERE severity IN ('high','critical'))::int AS critical_alerts_proxy,
           count(*) FILTER (
             WHERE event_type ILIKE '%failed_login%'
                OR event_type ILIKE '%auth.login.failure%'
                OR event_type = 'AUTH_FAILURE'
           )::int AS auth_failures_24h,
           count(*) FILTER (
             WHERE event_type ILIKE '%rate_limit%'
           )::int AS rate_limit_24h,
           count(*) FILTER (
             WHERE event_type ILIKE '%honeypot%'
           )::int AS honeypot_24h
         FROM security.events
         WHERE organization_id = $1
           AND created_at >= NOW() - INTERVAL '24 hours'`,
        [organizationId],
      ),
      db.query(
        `SELECT
           (SELECT count(*)::int FROM security.incidents
             WHERE organization_id = $1
               AND status IN ('open','investigating','contained')) AS active_incidents,
           (SELECT count(*)::int FROM security.alerts
             WHERE organization_id = $1
               AND status IN ('open','new','acknowledged','investigating')) AS open_alerts,
           (SELECT count(*)::int FROM security.blocklist
             WHERE organization_id = $1 AND unblocked_at IS NULL) AS blocked_requests,
           (SELECT count(*)::int FROM security.assets
             WHERE organization_id = $1 AND status = 'active') AS protected_assets,
           (SELECT count(*)::int FROM security.projects
             WHERE organization_id = $1 AND status = 'active') AS protected_projects`,
        [organizationId],
      ),
      db.query(
        `SELECT id, slug, name, asset_type, environment, status, criticality
         FROM security.assets
         WHERE organization_id = $1 AND status <> 'retired'
         ORDER BY criticality DESC, name ASC
         LIMIT 20`,
        [organizationId],
      ),
      db.query(
        `SELECT id, event_type, severity, ip_address, endpoint, risk_score, created_at
         FROM security.events
         WHERE organization_id = $1
         ORDER BY created_at DESC
         LIMIT 25`,
        [organizationId],
      ),
      db.query(
        `SELECT ip_address,
                count(*)::int AS event_count,
                count(*) FILTER (
                  WHERE event_type ILIKE '%failed_login%'
                     OR event_type ILIKE '%auth.login.failure%'
                     OR event_type = 'AUTH_FAILURE'
                )::int AS failed_auths,
                max(created_at) AS last_seen
         FROM security.events
         WHERE organization_id = $1
           AND ip_address IS NOT NULL
           AND created_at >= NOW() - INTERVAL '24 hours'
         GROUP BY ip_address
         ORDER BY event_count DESC
         LIMIT 10`,
        [organizationId],
      ),
    ]);

    const w = window24h.rows[0] ?? {};
    const o = open.rows[0] ?? {};

    return {
      security_status:
        Number(o.active_incidents ?? 0) > 0
          ? 'incidents_active'
          : Number(o.open_alerts ?? 0) > 0
            ? 'alerts_open'
            : Number(w.events_24h ?? 0) > 0
              ? 'observing'
              : 'quiet',
      active_incidents: Number(o.active_incidents ?? 0),
      open_alerts: Number(o.open_alerts ?? 0),
      events_24h: Number(w.events_24h ?? 0),
      auth_failures_24h: Number(w.auth_failures_24h ?? 0),
      rate_limit_violations_24h: Number(w.rate_limit_24h ?? 0),
      honeypot_interactions_24h: Number(w.honeypot_24h ?? 0),
      blocked_sources: Number(o.blocked_requests ?? 0),
      protected_assets: Number(o.protected_assets ?? 0),
      protected_projects: Number(o.protected_projects ?? 0),
      high_severity_events_24h: Number(w.critical_alerts_proxy ?? 0),
      suspicious_source_ips: topIps.rows.map((row) => ({
        ip_address: row.ip_address,
        event_count: Number(row.event_count),
        failed_authentications: Number(row.failed_auths),
        last_seen: iso(row.last_seen),
      })),
      recent_events: recent.rows.map((row) => ({
        id: row.id,
        event_type: row.event_type,
        severity: row.severity,
        ip_address: row.ip_address ?? null,
        endpoint: row.endpoint ?? null,
        risk_score: Number(row.risk_score ?? 0),
        created_at: iso(row.created_at),
      })),
      assets: assets.rows,
    };
  }

  async investigateByIp(organizationId: string, ipAddress: string) {
    const [agg, routes, reputation, incidents] = await Promise.all([
      db.query(
        `SELECT
           min(created_at) AS first_seen,
           max(created_at) AS last_seen,
           count(*)::int AS event_count,
           count(*) FILTER (
             WHERE event_type ILIKE '%failed_login%'
                OR event_type ILIKE '%auth.login.failure%'
                OR event_type = 'AUTH_FAILURE'
           )::int AS failed_authentications,
           count(*) FILTER (
             WHERE event_type ILIKE '%forbidden%'
                OR event_type ILIKE '%authorization%'
                OR event_type ILIKE '%permission%'
           )::int AS authorization_failures,
           count(*) FILTER (WHERE event_type ILIKE '%rate_limit%')::int AS rate_limit_violations
         FROM security.events
         WHERE organization_id = $1 AND ip_address = $2`,
        [organizationId, ipAddress],
      ),
      db.query(
        `SELECT COALESCE(endpoint, '(none)') AS endpoint,
                count(*)::int AS hits
         FROM security.events
         WHERE organization_id = $1 AND ip_address = $2
         GROUP BY endpoint
         ORDER BY hits DESC
         LIMIT 20`,
        [organizationId, ipAddress],
      ),
      db.query(
        `SELECT * FROM security.ip_reputation
         WHERE organization_id = $1 AND ip_address = $2`,
        [organizationId, ipAddress],
      ),
      db.query(
        `SELECT id, public_id, title, severity, status, created_at
         FROM security.incidents
         WHERE organization_id = $1 AND related_ip_address = $2
         ORDER BY created_at DESC
         LIMIT 20`,
        [organizationId, ipAddress],
      ),
    ]);

    const a = agg.rows[0] ?? {};
    const rep = reputation.rows[0];

    return {
      observed_source: {
        ip_address: ipAddress,
        attribution: 'unknown',
        note:
          'An IP address is an observed technical source. It may represent NAT, VPN, Tor, cloud infrastructure, proxy, mobile carrier, or a shared connection — not proof of a person\'s identity.',
      },
      activity: {
        first_seen: iso(a.first_seen),
        last_seen: iso(a.last_seen),
        event_count: Number(a.event_count ?? 0),
        failed_authentications: Number(a.failed_authentications ?? 0),
        authorization_failures: Number(a.authorization_failures ?? 0),
        rate_limit_violations: Number(a.rate_limit_violations ?? 0),
        targeted_routes: routes.rows.map((row) => ({
          endpoint: row.endpoint,
          hits: Number(row.hits),
        })),
      },
      network_intelligence: rep
        ? {
            ip_address: rep.ip_address,
            asn: rep.asn ?? null,
            network_provider: rep.isp ?? null,
            country: rep.country ?? null,
            region: rep.region ?? null,
            city: rep.city ?? null,
            risk_score: Number(rep.risk_score ?? 0),
            enriched_at: iso(rep.enriched_at),
          }
        : null,
      associated_incidents: incidents.rows.map((row) => ({
        id: row.id,
        public_id: row.public_id ?? null,
        title: row.title,
        severity: row.severity,
        status: row.status,
        created_at: iso(row.created_at),
      })),
    };
  }

  async listProjects(
    organizationId: string,
    page: { limit?: number; offset?: number } = {},
  ) {
    const limit = listLimit(page.limit);
    const result = await db.query(
      `SELECT p.*,
              (SELECT count(*)::int FROM security.assets a
                WHERE a.project_id = p.id AND a.status <> 'retired') AS asset_count
       FROM security.projects p
       WHERE p.organization_id = $1
       ORDER BY p.name ASC, p.id ASC
       LIMIT $2 OFFSET $3`,
      [organizationId, limit + 1, listOffset(page.offset)],
    );
    const mapped = result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      asset_count: Number(row.asset_count ?? 0),
      metadata: row.metadata ?? {},
    }));
    const paged = pageOf(mapped, limit);
    return { projects: paged.rows, hasMore: paged.hasMore };
  }

  async createProject(
    organizationId: string,
    actorUserId: string,
    input: {
      slug: string;
      name: string;
      description?: string | null;
      criticality?: string;
    },
  ) {
    const result = await db.query(
      `INSERT INTO security.projects (
         organization_id, slug, name, description, criticality, owner_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        organizationId,
        input.slug,
        input.name,
        input.description ?? null,
        input.criticality ?? 'medium',
        actorUserId,
      ],
    );
    await this.appendAudit(organizationId, actorUserId, {
      action: 'project.create',
      resourceType: 'security.project',
      resourceId: String(result.rows[0].id),
      resultingState: { slug: input.slug, name: input.name },
    });
    return result.rows[0];
  }

  async listAssets(
    organizationId: string,
    projectId?: string | null,
    page: { limit?: number; offset?: number } = {},
  ) {
    const limit = listLimit(page.limit);
    const result = await db.query(
      `SELECT a.*, p.slug AS project_slug, p.name AS project_name
       FROM security.assets a
       LEFT JOIN security.projects p ON p.id = a.project_id
       WHERE a.organization_id = $1
         AND ($2::uuid IS NULL OR a.project_id = $2)
       ORDER BY a.name ASC, a.id ASC
       LIMIT $3 OFFSET $4`,
      [organizationId, projectId ?? null, limit + 1, listOffset(page.offset)],
    );
    const mapped = result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      metadata: row.metadata ?? {},
    }));
    const paged = pageOf(mapped, limit);
    return { assets: paged.rows, hasMore: paged.hasMore };
  }

  async createAsset(
    organizationId: string,
    actorUserId: string,
    input: {
      slug: string;
      name: string;
      assetType?: string;
      environment?: string;
      hostname?: string | null;
      projectId?: string | null;
      criticality?: string;
    },
  ) {
    const result = await db.query(
      `INSERT INTO security.assets (
         organization_id, project_id, slug, name, asset_type, environment,
         hostname, criticality, owner_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        organizationId,
        input.projectId ?? null,
        input.slug,
        input.name,
        input.assetType ?? 'service',
        input.environment ?? 'production',
        input.hostname ?? null,
        input.criticality ?? 'medium',
        actorUserId,
      ],
    );
    await this.appendAudit(organizationId, actorUserId, {
      action: 'asset.create',
      resourceType: 'security.asset',
      resourceId: String(result.rows[0].id),
      resultingState: { slug: input.slug, name: input.name },
    });
    return result.rows[0];
  }

  async getIncidentDetail(organizationId: string, incidentId: string) {
    const incident = await db.query(
      `SELECT i.*
       FROM security.incidents i
       WHERE i.organization_id = $1 AND i.id = $2`,
      [organizationId, incidentId],
    );
    if (!incident.rows[0]) {
      throw new NotFoundError('INCIDENT_NOT_FOUND', 'Incident not found.');
    }
    const timeline = await db.query(
      `SELECT e.id, e.event_type, e.severity, e.ip_address, e.endpoint,
              e.risk_score, e.created_at, ie.linked_at
       FROM security.incident_events ie
       JOIN security.events e ON e.id = ie.event_id
       WHERE ie.incident_id = $1 AND e.organization_id = $2
       ORDER BY e.created_at ASC`,
      [incidentId, organizationId],
    );

    // Fallback: legacy event_ids array
    let events = timeline.rows;
    if (!events.length && Array.isArray(incident.rows[0].event_ids)) {
      const legacy = await db.query(
        `SELECT id, event_type, severity, ip_address, endpoint, risk_score, created_at,
                created_at AS linked_at
         FROM security.events
         WHERE organization_id = $1 AND id = ANY($2::uuid[])
         ORDER BY created_at ASC`,
        [organizationId, incident.rows[0].event_ids],
      );
      events = legacy.rows;
    }

    const row = incident.rows[0];
    return {
      incident: {
        ...row,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        resolved_at: iso(row.resolved_at),
        first_seen_at: iso(row.first_seen_at),
        last_seen_at: iso(row.last_seen_at),
      },
      timeline: events.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        severity: e.severity,
        ip_address: e.ip_address ?? null,
        endpoint: e.endpoint ?? null,
        risk_score: Number(e.risk_score ?? 0),
        created_at: iso(e.created_at),
        linked_at: iso(e.linked_at),
      })),
    };
  }

  async listAuditLog(organizationId: string, limit = 100) {
    const result = await db.query(
      `SELECT a.*, u.email AS actor_email
       FROM security.audit_log a
       LEFT JOIN identity.users u ON u.id = a.actor_user_id
       WHERE a.organization_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [organizationId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      previous_state: row.previous_state ?? null,
      resulting_state: row.resulting_state ?? null,
      metadata: row.metadata ?? {},
    }));
  }

  async appendAudit(
    organizationId: string,
    actorUserId: string | null,
    input: {
      action: string;
      resourceType: string;
      resourceId?: string | null;
      previousState?: Record<string, unknown> | null;
      resultingState?: Record<string, unknown> | null;
      reason?: string | null;
      requestId?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    await db.query(
      `INSERT INTO security.audit_log (
         organization_id, actor_user_id, action, resource_type, resource_id,
         previous_state, resulting_state, reason, request_id, ip_address,
         user_agent, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb
       )`,
      [
        organizationId,
        actorUserId,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.previousState ? JSON.stringify(input.previousState) : null,
        input.resultingState ? JSON.stringify(input.resultingState) : null,
        input.reason ?? null,
        input.requestId ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async listHoneypots(organizationId: string) {
    const result = await db.query(
      `SELECT * FROM security.honeypots
       WHERE organization_id = $1
       ORDER BY name ASC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      metadata: row.metadata ?? {},
    }));
  }

  async createHoneypot(
    organizationId: string,
    actorUserId: string,
    input: {
      slug: string;
      name: string;
      endpointPath: string;
      severity?: string;
      enabled?: boolean;
      projectId?: string | null;
      assetId?: string | null;
    },
  ) {
    const result = await db.query(
      `INSERT INTO security.honeypots (
         organization_id, project_id, asset_id, slug, name, endpoint_path,
         enabled, severity
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        organizationId,
        input.projectId ?? null,
        input.assetId ?? null,
        input.slug,
        input.name,
        input.endpointPath,
        input.enabled ?? false,
        input.severity ?? 'high',
      ],
    );
    await this.appendAudit(organizationId, actorUserId, {
      action: 'honeypot.create',
      resourceType: 'security.honeypot',
      resourceId: String(result.rows[0].id),
      resultingState: {
        slug: input.slug,
        endpoint_path: input.endpointPath,
        enabled: input.enabled ?? false,
      },
    });
    return result.rows[0];
  }

  async findEnabledHoneypotByPath(endpointPath: string) {
    const result = await db.query(
      `SELECT * FROM security.honeypots
       WHERE enabled = TRUE AND endpoint_path = $1
       LIMIT 1`,
      [endpointPath],
    );
    return result.rows[0] ?? null;
  }

  async findEnabledHoneypotBySlug(slug: string) {
    const result = await db.query(
      `SELECT * FROM security.honeypots
       WHERE enabled = TRUE AND slug = $1
       LIMIT 1`,
      [slug],
    );
    return result.rows[0] ?? null;
  }

  async recordContainment(
    organizationId: string,
    actorUserId: string,
    input: {
      actionType: string;
      targetType: string;
      targetValue: string;
      reason: string;
      incidentId?: string | null;
      previousState?: Record<string, unknown> | null;
      resultingState?: Record<string, unknown> | null;
      automatic?: boolean;
      metadata?: Record<string, unknown>;
    },
  ) {
    const result = await db.query(
      `INSERT INTO security.containment_actions (
         organization_id, action_type, target_type, target_value, reason,
         performed_by, incident_id, previous_state, resulting_state,
         automatic, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb)
       RETURNING *`,
      [
        organizationId,
        input.actionType,
        input.targetType,
        input.targetValue,
        input.reason,
        actorUserId,
        input.incidentId ?? null,
        input.previousState ? JSON.stringify(input.previousState) : null,
        input.resultingState ? JSON.stringify(input.resultingState) : null,
        Boolean(input.automatic),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    await this.appendAudit(organizationId, actorUserId, {
      action: `containment.${input.actionType}`,
      resourceType: input.targetType,
      resourceId: input.targetValue,
      reason: input.reason,
      previousState: input.previousState ?? null,
      resultingState: input.resultingState ?? null,
    });
    return result.rows[0];
  }

  async listDetectionRules(organizationId: string) {
    const result = await db.query(
      `SELECT r.*, ms.slug AS system_slug
       FROM security.detection_rules r
       LEFT JOIN security.monitored_systems ms ON ms.id = r.system_id
       WHERE r.organization_id = $1
       ORDER BY r.name ASC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      metadata: row.metadata ?? {},
    }));
  }

  async resolveOrganizationIdForUser(userId: string): Promise<string | null> {
    const result = await db.query(
      `SELECT organization_id
       FROM organizations.memberships
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId],
    );
    return (result.rows[0]?.organization_id as string | undefined) ?? null;
  }
}
