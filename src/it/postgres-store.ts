import { keysetPredicate, listLimit, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import {
  buildStorageSnapshot,
  classifyProbe,
  probeLivekit,
  probeObjectStorage,
  readHostDiskUsage,
  readHostRamUsage,
  runtimeDiagnostics,
} from './host-metrics.js';

function iso(v: unknown) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function dateOnly(v: unknown) {
  if (!v) return null;
  return String(v).slice(0, 10);
}

async function readContentStudioBytes(organizationId: string): Promise<number> {
  const result = await db.query<{ bytes: string | number }>(
    `SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes FROM (
       SELECT bucket, object_key, MAX(bytes) AS bytes FROM (
         SELECT m.bucket, COALESCE(NULLIF(m.storage_path, ''), m.file_url) AS object_key,
                COALESCE(m.stored_size_bytes, m.original_size_bytes, 0) AS bytes
         FROM content.client_media m JOIN content.clients c ON c.id = m.client_id
         WHERE c.organization_id = $1
         UNION ALL
         SELECT a.bucket, COALESCE(NULLIF(a.storage_path, ''), a.file_url) AS object_key,
                COALESCE(a.stored_size_bytes, a.original_size_bytes, 0) AS bytes
         FROM content.schedule_assets a JOIN content.schedules s ON s.id = a.schedule_id
         WHERE s.organization_id = $1
       ) refs GROUP BY bucket, object_key
     ) objects`,
    [organizationId],
  );
  return Number(result.rows[0]?.bytes ?? 0);
}

async function readDatabaseBytes(): Promise<number> {
  const result = await db.query<{ bytes: string | number }>(
    `SELECT pg_database_size(current_database())::bigint AS bytes`,
  );
  return Number(result.rows[0]?.bytes ?? 0);
}

export class PostgresItStore {
  private readonly healthSamples = new Map<string, { expiresAt: number; result: ReturnType<PostgresItStore['collectHealth']> }>();

  async healthCheck(organizationId: string) {
    const cached = this.healthSamples.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    // Coalesce dashboard polling and bound memory across organizations.
    for (const [key, sample] of this.healthSamples) {
      if (sample.expiresAt <= Date.now()) this.healthSamples.delete(key);
    }
    if (this.healthSamples.size >= 100) this.healthSamples.delete(this.healthSamples.keys().next().value!);
    const result = this.collectHealth(organizationId).catch((error) => {
      this.healthSamples.delete(organizationId);
      throw error;
    });
    this.healthSamples.set(organizationId, { expiresAt: Date.now() + 30_000, result });
    return result;
  }

  private async collectHealth(organizationId: string) {
    const start = Date.now();
    const [databaseProbe, databaseBytes, storageBytes, disk, livekit, objectStorage] =
      await Promise.all([
        (async () => {
          const queryStarted = Date.now();
          try {
            const result = await db.query(
              `SELECT 1 AS ok,
                  (SELECT count(*)::int FROM it.projects WHERE organization_id = $1) AS projects,
                  (SELECT count(*)::int FROM it.issues WHERE organization_id = $1 AND status IN ('open','in_progress')) AS open_issues,
                  (SELECT count(*)::int FROM it.incidents WHERE organization_id = $1 AND status <> 'resolved') AS open_incidents,
                  (SELECT count(*)::int FROM it.system_alerts WHERE organization_id = $1 AND status = 'open') AS open_alerts,
                  (SELECT count(*)::int FROM it.account_access_requests
                    WHERE status = 'pending'
                      AND (organization_id = $1 OR organization_id IS NULL)) AS pending_access_requests`,
              [organizationId],
            );
            return { ok: true as const, result, latencyMs: Date.now() - queryStarted };
          } catch {
            return { ok: false as const, result: null, latencyMs: Date.now() - queryStarted };
          }
        })(),
        readDatabaseBytes().catch(() => null),
        readContentStudioBytes(organizationId).catch(() => null),
        readHostDiskUsage(),
        probeLivekit(),
        probeObjectStorage(),
      ]);
    const ram = readHostRamUsage();
    const storage = buildStorageSnapshot({
      databaseBytes,
      storageBytes,
      disk,
      ram,
    });
    const row = databaseProbe.result?.rows[0] ?? {};
    const warnings: string[] = [];
    if (!databaseProbe.ok) warnings.push('Database query failed.');
    if (databaseBytes == null) warnings.push('Database size measurement unavailable.');
    if (storageBytes == null) warnings.push('Content media size estimate unavailable.');
    if (disk.source === 'unavailable') warnings.push('Disk usage measurement unavailable.');
    if (disk.source === 'env') warnings.push('Disk usage is a configured estimate, not a live measurement.');
    if (
      storage.diskPercent != null &&
      storage.diskPercent >= 85
    ) {
      warnings.push('Disk capacity is above 85%.');
    }
    if (objectStorage.status === 'down') {
      warnings.push('Object storage did not respond.');
    }
    if (livekit.status === 'down') {
      warnings.push('LiveKit media server did not respond.');
    }

    const apiLatencyMs = databaseProbe.latencyMs;
    const services = {
      database: {
        status: classifyProbe(databaseProbe.ok, databaseProbe.latencyMs),
        latencyMs: databaseProbe.latencyMs,
      },
      api: {
        status: classifyProbe(true, apiLatencyMs),
        latencyMs: apiLatencyMs,
      },
      auth: {
        status: 'healthy' as const,
        latencyMs: null as number | null,
      },
      storage: {
        status: objectStorage.status,
        latencyMs: objectStorage.latencyMs,
        httpStatus: objectStorage.httpStatus,
      },
      livekit: {
        status: livekit.status,
        latencyMs: livekit.latencyMs,
        httpStatus: livekit.httpStatus,
      },
    };

    return {
      ok: databaseProbe.ok,
      checkedAt: new Date().toISOString(),
      organizationId,
      latencyMs: Date.now() - start,
      counts: {
        projects: row.projects ?? 0,
        open_issues: row.open_issues ?? 0,
        open_incidents: row.open_incidents ?? 0,
        open_alerts: row.open_alerts ?? 0,
        pending_access_requests: row.pending_access_requests ?? 0,
      },
      tableChecks: [
        { table: 'it.projects', ok: databaseProbe.ok, error: databaseProbe.ok ? null : 'query failed' },
        { table: 'it.issues', ok: databaseProbe.ok, error: databaseProbe.ok ? null : 'query failed' },
        { table: 'it.system_alerts', ok: databaseProbe.ok, error: databaseProbe.ok ? null : 'query failed' },
      ],
      warnings,
      services,
      storage,
      diagnostics: {
        ...runtimeDiagnostics(), ramSource: ram.source,
        databasePool: { total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount },
        storageSource: 'deduplicated-content-metadata',
        storageScope: 'organization-content-only',
        databaseScope: 'entire-database',
        diskScope: 'api-visible-filesystem',
        diskBreakdownAvailable: false,
        historyAvailable: false,
      },
      disk: {
        usedBytes: disk.usedBytes,
        totalBytes: disk.totalBytes,
        source: disk.source,
      },
      livekit,
      environment: {
        kode: true,
        database: databaseProbe.ok ? 'ok' : 'error',
        livekitUrl: livekit.url,
        diskSource: disk.source,
        objectStorage: objectStorage.status,
      },
    };
  }

  async dashboardStats(organizationId: string) {
    const result = await db.query(
      `SELECT
         (SELECT count(*)::int FROM it.projects WHERE organization_id = $1 AND status = 'active') AS active_projects,
         (SELECT count(*)::int FROM it.issues WHERE organization_id = $1 AND status IN ('open','in_progress')) AS open_issues,
         (SELECT count(*)::int FROM it.account_access_requests
           WHERE status = 'pending'
             AND (organization_id = $1 OR organization_id IS NULL)) AS pending_access_requests,
         (SELECT count(*)::int FROM it.system_alerts WHERE organization_id = $1 AND status = 'open') AS open_alerts,
         (SELECT count(*)::int FROM it.incidents WHERE organization_id = $1 AND status <> 'resolved') AS open_incidents`,
      [organizationId],
    );
    const row = result.rows[0] ?? {};
    const openAlerts = Number(row.open_alerts ?? 0);
    const openIncidents = Number(row.open_incidents ?? 0);
    const systemHealthLabel =
      openIncidents > 0 || openAlerts >= 3
        ? 'Critical'
        : openAlerts > 0
          ? 'Warning'
          : 'Healthy';
    return {
      activeProjects: Number(row.active_projects ?? 0),
      openIssues: Number(row.open_issues ?? 0),
      pendingAccountRequests: Number(row.pending_access_requests ?? 0),
      pendingInvites: Number(row.pending_access_requests ?? 0),
      openAlerts,
      openIncidents,
      systemHealthLabel,
      automationCount: 0,
    };
  }

  async listProjects(
    organizationId: string,
    userId?: string | null,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    let membershipFilter = '';
    if (userId) {
      params.push(userId);
      membershipFilter = `AND EXISTS (
        SELECT 1 FROM it.project_members m
        WHERE m.project_id = p.id AND m.user_id = $${params.length}
      )`;
    }
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'p.created_at',
      'p.id',
    );
    params.push(limit + 1);

    const result = await db.query(
      `SELECT p.*,
              (SELECT count(*)::int FROM it.project_members m WHERE m.project_id = p.id) AS members_count,
              (SELECT count(*)::int FROM it.issues i
                WHERE i.project_id = p.id AND i.status IN ('open','in_progress')) AS open_issues_count
       FROM it.projects p
       WHERE p.organization_id = $1
         ${membershipFilter}
         ${cursor}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${params.length}`,
      params,
    );

    const mapped = result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      name: row.name,
      description: row.description ?? null,
      status: row.status,
      priority: row.priority,
      due_date: dateOnly(row.due_date),
      created_by: row.created_by ?? null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      membersCount: Number(row.members_count ?? 0),
      openIssuesCount: Number(row.open_issues_count ?? 0),
      openTasksCount: 0,
      blockedTasksCount: 0,
      failedRuns24h: 0,
    }));
    const paged = pageOf(mapped, limit);
    return { projects: paged.rows, hasMore: paged.hasMore };
  }

  async createProject(
    organizationId: string,
    createdBy: string,
    input: {
      name: string;
      description?: string | null;
      status?: string;
      priority?: string;
      dueDate?: string | null;
    },
  ) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query(
        `INSERT INTO it.projects (
           organization_id, name, description, status, priority, due_date, created_by
         ) VALUES ($1,$2,$3,COALESCE($4,'active'),COALESCE($5,'medium'),$6,$7)
         RETURNING *`,
        [
          organizationId,
          input.name,
          input.description ?? null,
          input.status ?? 'active',
          input.priority ?? 'medium',
          input.dueDate ?? null,
          createdBy,
        ],
      );
      const row = project.rows[0];
      await client.query(
        `INSERT INTO it.project_members (organization_id, project_id, user_id, role, invited_by)
         VALUES ($1,$2,$3,'owner',$3)
         ON CONFLICT (project_id, user_id) DO NOTHING`,
        [organizationId, row.id, createdBy],
      );
      await client.query(
        `INSERT INTO it.project_activity (organization_id, project_id, user_id, action, details)
         VALUES ($1,$2,$3,'Project created',$4::jsonb)`,
        [
          organizationId,
          row.id,
          createdBy,
          JSON.stringify({
            project_name: row.name,
            status: row.status,
            priority: row.priority,
          }),
        ],
      );
      await client.query('COMMIT');
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        status: row.status,
        priority: row.priority,
        due_date: dateOnly(row.due_date),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateProject(
    organizationId: string,
    projectId: string,
    patch: Record<string, unknown>,
  ) {
    const result = await db.query(
      `UPDATE it.projects
       SET name = COALESCE($3, name),
           description = COALESCE($4, description),
           status = COALESCE($5, status),
           priority = COALESCE($6, priority),
           due_date = COALESCE($7::date, due_date),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        projectId,
        patch.name ?? null,
        patch.description ?? null,
        patch.status ?? null,
        patch.priority ?? null,
        patch.dueDate ?? patch.due_date ?? null,
      ],
    );
    if (!result.rows[0]) throw new NotFoundError('PROJECT_NOT_FOUND', 'Project not found.');
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      status: row.status,
      priority: row.priority,
      due_date: dateOnly(row.due_date),
      updated_at: iso(row.updated_at),
    };
  }

  async listProjectMembers(organizationId: string, projectId: string) {
    const result = await db.query(
      `SELECT m.*, p.full_name, u.email,
              om.role_key AS primary_role
       FROM it.project_members m
       LEFT JOIN identity.user_profiles p ON p.user_id = m.user_id
       LEFT JOIN identity.users u ON u.id = m.user_id
       LEFT JOIN organizations.memberships om
         ON om.user_id = m.user_id
        AND om.organization_id = m.organization_id
        AND om.removed_at IS NULL
        AND om.status = 'active'
       WHERE m.organization_id = $1 AND m.project_id = $2
       ORDER BY m.created_at ASC`,
      [organizationId, projectId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      role: row.role,
      joined_at: iso(row.created_at),
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      primary_role: row.primary_role ?? null,
    }));
  }

  async listProjectActivity(organizationId: string, projectId: string, limit = 10) {
    const result = await db.query(
      `SELECT a.*, p.full_name, u.email
       FROM it.project_activity a
       LEFT JOIN identity.user_profiles p ON p.user_id = a.user_id
       LEFT JOIN identity.users u ON u.id = a.user_id
       WHERE a.organization_id = $1 AND a.project_id = $2
       ORDER BY a.created_at DESC
       LIMIT $3`,
      [organizationId, projectId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      created_at: iso(row.created_at),
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      details: row.details ?? {},
    }));
  }

  async listRecentActivity(organizationId: string, limit = 8) {
    const result = await db.query(
      `SELECT a.*, p.full_name, u.email
       FROM it.project_activity a
       LEFT JOIN identity.user_profiles p ON p.user_id = a.user_id
       LEFT JOIN identity.users u ON u.id = a.user_id
       WHERE a.organization_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      created_at: iso(row.created_at),
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      details: row.details ?? {},
    }));
  }

  async listIssues(organizationId: string, projectId?: string | null) {
    const params: unknown[] = [organizationId];
    let projectFilter = '';
    if (projectId) {
      params.push(projectId);
      projectFilter = 'AND i.project_id = $2';
    }
    const result = await db.query(
      `SELECT i.* FROM it.issues i
       WHERE i.organization_id = $1 ${projectFilter}
       ORDER BY i.created_at DESC
       LIMIT 200`,
      params,
    );
    return result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      project_id: row.project_id ?? null,
      title: row.title,
      status: row.status,
      severity: row.severity,
      assignee_id: row.assignee_id ?? null,
      description: row.description ?? null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }));
  }

  async createIssue(
    organizationId: string,
    input: {
      title: string;
      description?: string | null;
      severity?: string;
      status?: string;
      projectId?: string | null;
      assigneeId?: string | null;
    },
  ) {
    const result = await db.query(
      `INSERT INTO it.issues (
         organization_id, project_id, title, description, severity, status, assignee_id
       ) VALUES ($1,$2,$3,$4,COALESCE($5,'medium'),COALESCE($6,'open'),$7)
       RETURNING *`,
      [
        organizationId,
        input.projectId ?? null,
        input.title,
        input.description ?? null,
        input.severity ?? 'medium',
        input.status ?? 'open',
        input.assigneeId ?? null,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      organization_id: row.organization_id,
      project_id: row.project_id ?? null,
      title: row.title,
      status: row.status,
      severity: row.severity,
      assignee_id: row.assignee_id ?? null,
      description: row.description ?? null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  async updateIssue(
    organizationId: string,
    issueId: string,
    patch: Record<string, unknown>,
  ) {
    const result = await db.query(
      `UPDATE it.issues
       SET title = COALESCE($3, title),
           description = COALESCE($4, description),
           status = COALESCE($5, status),
           severity = COALESCE($6, severity),
           assignee_id = COALESCE($7, assignee_id),
           project_id = COALESCE($8, project_id),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        issueId,
        patch.title ?? null,
        patch.description ?? null,
        patch.status ?? null,
        patch.severity ?? null,
        patch.assigneeId ?? patch.assignee_id ?? null,
        patch.projectId ?? patch.project_id ?? null,
      ],
    );
    if (!result.rows[0]) throw new NotFoundError('ISSUE_NOT_FOUND', 'Issue not found.');
    const row = result.rows[0];
    return {
      id: row.id,
      organization_id: row.organization_id,
      project_id: row.project_id ?? null,
      title: row.title,
      status: row.status,
      severity: row.severity,
      assignee_id: row.assignee_id ?? null,
      description: row.description ?? null,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  async countOpenIssues(organizationId: string) {
    const result = await db.query(
      `SELECT count(*)::int AS count FROM it.issues
       WHERE organization_id = $1 AND status IN ('open','in_progress')`,
      [organizationId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listMonitors(organizationId: string) {
    const result = await db.query(
      `SELECT * FROM it.system_monitors
       WHERE organization_id = $1
       ORDER BY name ASC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      name: row.name,
      monitor_type: row.monitor_type,
      status: row.status,
      last_checked_at: iso(row.last_check_at),
      last_check_at: iso(row.last_check_at),
      details: row.metadata ?? {},
      metadata: row.metadata ?? {},
    }));
  }

  async upsertMonitor(
    organizationId: string,
    input: {
      name: string;
      monitorType?: string;
      status?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const result = await db.query(
      `INSERT INTO it.system_monitors (
         organization_id, name, monitor_type, status, last_check_at, metadata
       ) VALUES ($1,$2,COALESCE($3,'service'),COALESCE($4,'unknown'),NOW(),COALESCE($5,'{}'::jsonb))
       ON CONFLICT (organization_id, name) DO UPDATE
       SET status = EXCLUDED.status,
           monitor_type = EXCLUDED.monitor_type,
           metadata = EXCLUDED.metadata,
           last_check_at = NOW(),
           updated_at = NOW()
       RETURNING *`,
      [
        organizationId,
        input.name,
        input.monitorType ?? 'service',
        input.status ?? 'unknown',
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      monitor_type: row.monitor_type,
      status: row.status,
      last_checked_at: iso(row.last_check_at),
      details: row.metadata ?? {},
    };
  }

  async listAlerts(organizationId: string, limit = 50) {
    const result = await db.query(
      `SELECT * FROM it.system_alerts
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      description: row.description ?? null,
      module: row.module ?? null,
      message: row.message ?? row.description ?? null,
      related_entity_type: row.related_entity_type ?? null,
      related_entity_id: row.related_entity_id ?? null,
      resolved_at: iso(row.resolved_at),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }));
  }

  async createAlert(
    organizationId: string,
    input: {
      title: string;
      severity?: string;
      description?: string | null;
      module?: string | null;
      message?: string | null;
    },
  ) {
    const result = await db.query(
      `INSERT INTO it.system_alerts (
         organization_id, title, severity, description, module, message, status
       ) VALUES ($1,$2,COALESCE($3,'medium'),$4,$5,$6,'open')
       RETURNING *`,
      [
        organizationId,
        input.title,
        input.severity ?? 'medium',
        input.description ?? null,
        input.module ?? null,
        input.message ?? input.description ?? null,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      description: row.description ?? null,
      created_at: iso(row.created_at),
    };
  }

  async resolveAlert(organizationId: string, alertId: string) {
    const result = await db.query(
      `UPDATE it.system_alerts
       SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [organizationId, alertId],
    );
    if (!result.rows[0]) throw new NotFoundError('ALERT_NOT_FOUND', 'Alert not found.');
    const row = result.rows[0];
    return {
      id: row.id,
      status: row.status,
      resolved_at: iso(row.resolved_at),
    };
  }

  async listEvents(organizationId: string, limit = 50) {
    const result = await db.query(
      `SELECT * FROM it.system_events
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      event_type: row.event_type,
      message: row.message ?? null,
      severity: row.severity,
      title: row.title ?? row.message ?? row.event_type,
      description: row.description ?? row.message ?? null,
      module: row.module ?? null,
      metadata: row.metadata ?? {},
      created_at: iso(row.created_at),
    }));
  }

  async createEvent(
    organizationId: string,
    input: {
      eventType: string;
      message?: string | null;
      severity?: string;
      title?: string | null;
      description?: string | null;
      module?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const result = await db.query(
      `INSERT INTO it.system_events (
         organization_id, event_type, message, severity, title, description, module, metadata
       ) VALUES ($1,$2,$3,COALESCE($4,'info'),$5,$6,$7,COALESCE($8,'{}'::jsonb))
       RETURNING *`,
      [
        organizationId,
        input.eventType,
        input.message ?? null,
        input.severity ?? 'info',
        input.title ?? null,
        input.description ?? null,
        input.module ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      event_type: row.event_type,
      message: row.message ?? null,
      severity: row.severity,
      created_at: iso(row.created_at),
    };
  }

  async listAccountAccessRequests(organizationId: string, limit = 50) {
    const result = await db.query(
      `SELECT * FROM it.account_access_requests
       WHERE organization_id = $1 OR organization_id IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id ?? null,
      user_id: row.user_id ?? null,
      full_name: row.full_name,
      email: row.email,
      phone: row.phone ?? null,
      company: row.company ?? null,
      requested_role: row.requested_role ?? null,
      message: row.message ?? null,
      reason: row.reason ?? null,
      status: row.status,
      reviewed_by: row.reviewed_by ?? null,
      reviewed_at: iso(row.reviewed_at),
      review_notes: row.review_notes ?? null,
      created_at: iso(row.created_at),
    }));
  }

  async submitAccountAccessRequest(input: {
    organizationId?: string | null;
    userId?: string | null;
    fullName: string;
    email: string;
    phone?: string | null;
    company?: string | null;
    requestedRole?: string | null;
    message?: string | null;
    reason?: string | null;
  }) {
    const result = await db.query(
      `INSERT INTO it.account_access_requests (
         organization_id, user_id, full_name, email, phone, company,
         requested_role, message, reason, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
       RETURNING id`,
      [
        input.organizationId ?? null,
        input.userId ?? null,
        input.fullName,
        input.email,
        input.phone ?? null,
        input.company ?? null,
        input.requestedRole ?? null,
        input.message ?? null,
        input.reason ?? null,
      ],
    );
    return { id: result.rows[0].id as string };
  }

  async reviewAccountAccessRequest(params: {
    organizationId: string;
    requestId: string;
    reviewerId: string;
    status: 'approved' | 'rejected';
    notes?: string | null;
  }) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE it.account_access_requests
         SET organization_id = $3,
             status = $4,
             reviewed_by = $5,
             reviewed_at = NOW(),
             review_notes = $6,
             updated_at = NOW()
         WHERE id = $1
           AND (organization_id = $2 OR organization_id IS NULL)
         RETURNING *`,
        [
          params.requestId,
          params.organizationId,
          params.organizationId,
          params.status,
          params.reviewerId,
          params.notes ?? null,
        ],
      );
      if (!updated.rows[0]) {
        throw new NotFoundError('ACCESS_REQUEST_NOT_FOUND', 'Access request not found.');
      }
      await client.query(
        `INSERT INTO it.audit_logs (
           organization_id, actor_user_id, action, reason, metadata
         ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          params.organizationId,
          params.reviewerId,
          `account_request_${params.status}`,
          params.notes ?? null,
          JSON.stringify({ request_id: params.requestId }),
        ],
      );
      await client.query('COMMIT');
      const row = updated.rows[0];
      return {
        id: row.id,
        status: row.status,
        reviewed_by: row.reviewed_by,
        reviewed_at: iso(row.reviewed_at),
        review_notes: row.review_notes ?? null,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listIncidents(organizationId: string, limit = 20) {
    const result = await db.query(
      `SELECT * FROM it.incidents
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      description: row.description ?? null,
      created_by: row.created_by ?? null,
      assigned_to: row.assigned_to ?? null,
      created_at: iso(row.created_at),
      resolved_at: iso(row.resolved_at),
    }));
  }

  async createIncident(
    organizationId: string,
    createdBy: string,
    input: {
      title: string;
      severity: string;
      description?: string | null;
    },
  ) {
    const result = await db.query(
      `INSERT INTO it.incidents (
         organization_id, title, severity, description, created_by, status
       ) VALUES ($1,$2,$3,$4,$5,'open')
       RETURNING *`,
      [
        organizationId,
        input.title,
        input.severity,
        input.description ?? null,
        createdBy,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      organization_id: row.organization_id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      description: row.description ?? null,
      created_by: row.created_by ?? null,
      assigned_to: row.assigned_to ?? null,
      created_at: iso(row.created_at),
      resolved_at: iso(row.resolved_at),
    };
  }

  async listAuditLogs(organizationId: string, limit = 30) {
    const result = await db.query(
      `SELECT * FROM it.audit_logs
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      actor_user_id: row.actor_user_id ?? null,
      target_user_id: row.target_user_id ?? null,
      action: row.action,
      reason: row.reason ?? null,
      metadata: row.metadata ?? {},
      created_at: iso(row.created_at),
    }));
  }

  async adminUserAction(params: {
    organizationId: string;
    actorUserId: string;
    action: string;
    targetUserId: string;
    newRole?: string | null;
    reason?: string | null;
  }) {
    const { organizationId, actorUserId, action, targetUserId } = params;
    if (actorUserId === targetUserId) {
      throw new ValidationError('You cannot run admin user actions on yourself.');
    }

    const member = await db.query(
      `SELECT m.user_id, m.role_key, m.status, u.account_status
       FROM organizations.memberships m
       INNER JOIN identity.users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND m.user_id = $2`,
      [organizationId, targetUserId],
    );
    if (!member.rows[0]) {
      throw new NotFoundError('MEMBER_NOT_FOUND', 'Target member was not found.');
    }

    const reason = params.reason?.trim() || null;

    if (action === 'hard_delete_auth_user') {
      // Soft-delete equivalent — never hard-delete auth rows from war room.
      await db.query(
        `UPDATE identity.users
         SET account_status = 'deleted', is_active = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [targetUserId],
      );
      await db.query(
        `UPDATE identity.user_profiles
         SET deleted_at = NOW(),
             deleted_by = $2,
             deletion_reason = $3,
             is_suspended = FALSE,
             updated_at = NOW()
         WHERE user_id = $1`,
        [targetUserId, actorUserId, reason],
      );
      await db.query(
        `UPDATE organizations.memberships
         SET status = 'removed', removed_at = NOW(), removed_by = $3, updated_at = NOW()
         WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, targetUserId, actorUserId],
      );
      await db.query(
        `INSERT INTO it.audit_logs (
           organization_id, actor_user_id, target_user_id, action, reason, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          organizationId,
          actorUserId,
          targetUserId,
          'hard_delete_auth_user_mapped_to_soft_delete',
          reason,
          JSON.stringify({ mapped: true }),
        ],
      );
      return {
        ok: true,
        action,
        targetUserId,
        mappedTo: 'soft_delete',
      };
    }

    if (
      action !== 'suspend' &&
      action !== 'reactivate' &&
      action !== 'soft_delete' &&
      action !== 'change_role'
    ) {
      throw new ValidationError(`Unknown action: ${action}`);
    }

    if (action === 'suspend') {
      await db.query(
        `UPDATE identity.users
         SET account_status = 'suspended', is_active = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [targetUserId],
      );
      await db.query(
        `UPDATE identity.user_profiles
         SET is_suspended = TRUE,
             suspended_at = NOW(),
             suspended_by = $2,
             suspension_reason = $3,
             updated_at = NOW()
         WHERE user_id = $1`,
        [targetUserId, actorUserId, reason],
      );
      await db.query(
        `UPDATE organizations.memberships
         SET status = 'suspended', updated_at = NOW()
         WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, targetUserId],
      );
    } else if (action === 'reactivate') {
      await db.query(
        `UPDATE identity.users
         SET account_status = 'active', is_active = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [targetUserId],
      );
      await db.query(
        `UPDATE identity.user_profiles
         SET is_suspended = FALSE,
             suspended_at = NULL,
             suspended_by = NULL,
             suspension_reason = NULL,
             deleted_at = NULL,
             deleted_by = NULL,
             deletion_reason = NULL,
             updated_at = NOW()
         WHERE user_id = $1`,
        [targetUserId],
      );
      await db.query(
        `UPDATE organizations.memberships
         SET status = 'active', removed_at = NULL, removed_by = NULL, updated_at = NOW()
         WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, targetUserId],
      );
    } else if (action === 'soft_delete') {
      await db.query(
        `UPDATE identity.users
         SET account_status = 'deleted', is_active = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [targetUserId],
      );
      await db.query(
        `UPDATE identity.user_profiles
         SET deleted_at = NOW(),
             deleted_by = $2,
             deletion_reason = $3,
             is_suspended = FALSE,
             updated_at = NOW()
         WHERE user_id = $1`,
        [targetUserId, actorUserId, reason],
      );
      await db.query(
        `UPDATE organizations.memberships
         SET status = 'removed', removed_at = NOW(), removed_by = $3, updated_at = NOW()
         WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, targetUserId, actorUserId],
      );
    } else if (action === 'change_role') {
      const roleKey = String(params.newRole ?? '').trim();
      if (!roleKey) {
        throw new ValidationError('newRole is required for change_role.');
      }
      const role = await db.query(
        `SELECT id, role_key FROM organizations.roles
         WHERE organization_id = $1 AND role_key = $2
         LIMIT 1`,
        [organizationId, roleKey],
      );
      if (!role.rows[0]) {
        throw new NotFoundError('ROLE_NOT_FOUND', `Role "${roleKey}" was not found.`);
      }
      await db.query(
        `UPDATE organizations.memberships
         SET role_id = $3, role_key = $4, updated_at = NOW()
         WHERE organization_id = $1 AND user_id = $2`,
        [organizationId, targetUserId, role.rows[0].id, role.rows[0].role_key],
      );
      await db.query(
        `UPDATE identity.user_profiles
         SET primary_role_key = $2, updated_at = NOW()
         WHERE user_id = $1`,
        [targetUserId, role.rows[0].role_key],
      );
    }

    await db.query(
      `INSERT INTO it.audit_logs (
         organization_id, actor_user_id, target_user_id, action, reason, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        organizationId,
        actorUserId,
        targetUserId,
        action,
        reason,
        JSON.stringify({ newRole: params.newRole ?? null }),
      ],
    );

    return { ok: true, action, targetUserId };
  }
}
