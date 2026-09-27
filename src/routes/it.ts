import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';
import { readListQuery } from '../http/list-query.js';
import { db } from '../db/pool.js';
import { logger } from '../config/logger.js';
import { readJson, readRequiredText, requireUuidValue } from '../work/http.js';
import { isAdminManagerIt, requireProductOrg } from '../products/staff.js';
import type { PostgresItStore } from '../it/postgres-store.js';
import type { AuthContext } from '../authorization/types.js';
import type { PasswordService } from '../auth/password-service.js';
import { EmailDeliveryError } from '../auth/email.js';
import { createDefaultAuthLifecycle } from '../auth/defaults.js';

export type ItRouteDependencies = {
  store: PostgresItStore;
  passwords?: PasswordService;
};

const INM_OFFICE_SLUGS = new Set(['its-no-matata', 'itsnomatata']);

function authorize(auth: ReturnType<typeof getAuth>) {
  const organizationId = requireProductOrg(auth);
  if (!isAdminManagerIt(auth)) {
    throw new ForbiddenError('IT_ADMIN_REQUIRED', 'IT or admin access required.');
  }
  return organizationId;
}


async function authorizePlatformIt(auth: AuthContext) {
  const organizationId = authorize(auth);
  if (auth.membership.isAdminRole) return organizationId;
  if (auth.membership.roleKey !== 'it') return organizationId;

  const officeId = auth.membership.officeId;
  if (!officeId) {
    throw new ForbiddenError(
      'IT_PLATFORM_OFFICE_REQUIRED',
      'Control Centre is limited to ITs No Matata IT.',
    );
  }

  const result = await db.query<{ slug: string | null }>(
    `SELECT slug FROM organizations.offices WHERE id = $1 AND is_active = TRUE`,
    [officeId],
  );
  const slug = String(result.rows[0]?.slug ?? '')
    .trim()
    .toLowerCase();
  if (!INM_OFFICE_SLUGS.has(slug)) {
    throw new ForbiddenError(
      'IT_PLATFORM_RESTRICTED',
      'Control Centre is limited to ITs No Matata IT. Use Service Desk for tickets.',
    );
  }
  return organizationId;
}

export function createItRoutes(dependencies: ItRouteDependencies) {
  const routes = new Hono();
  const passwords =
    dependencies.passwords ?? createDefaultAuthLifecycle().passwords;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  routes.get('/health', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    return c.json(await dependencies.store.healthCheck(organizationId));
  });

  routes.get('/dashboard/stats', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    return c.json(await dependencies.store.dashboardStats(organizationId));
  });

  routes.get('/projects', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const forUser = c.req.query('forUser') === 'true' ? auth.actor.userId : null;
    const projects = await dependencies.store.listProjects(
      organizationId,
      forUser,
      readListQuery(c),
    );
    return c.json({ projects: projects.projects, hasMore: projects.hasMore });
  });

  routes.post('/projects', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const body = await readJson(c);
    const name = readRequiredText(body.name, 'name', 200);
    const project = await dependencies.store.createProject(organizationId, auth.actor.userId, {
      name,
      description: (body.description as string | null | undefined) ?? null,
      status: (body.status as string | undefined) ?? 'active',
      priority: (body.priority as string | undefined) ?? 'medium',
      dueDate: (body.dueDate ?? body.due_date ?? null) as string | null,
    });
    return c.json({ project }, 201);
  });

  routes.patch('/projects/:projectId', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const body = await readJson(c);
    return c.json({
      project: await dependencies.store.updateProject(organizationId, projectId, body),
    });
  });

  routes.get('/projects/:projectId/members', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    return c.json({
      members: await dependencies.store.listProjectMembers(organizationId, projectId),
    });
  });

  routes.get('/projects/:projectId/activity', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const limit = Number(c.req.query('limit') ?? 10);
    return c.json({
      activity: await dependencies.store.listProjectActivity(
        organizationId,
        projectId,
        Number.isFinite(limit) ? limit : 10,
      ),
    });
  });

  routes.get('/activity', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const limit = Number(c.req.query('limit') ?? 8);
    return c.json({
      activity: await dependencies.store.listRecentActivity(
        organizationId,
        Number.isFinite(limit) ? limit : 8,
      ),
    });
  });

  routes.get('/issues', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const projectId = c.req.query('projectId') ?? null;
    return c.json({
      issues: await dependencies.store.listIssues(organizationId, projectId),
      openCount: await dependencies.store.countOpenIssues(organizationId),
    });
  });

  routes.post('/issues', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const body = await readJson(c);
    const title = readRequiredText(body.title, 'title', 300);
    const issue = await dependencies.store.createIssue(organizationId, {
      title,
      description: (body.description as string | null | undefined) ?? null,
      severity: (body.severity as string | undefined) ?? 'medium',
      status: (body.status as string | undefined) ?? 'open',
      projectId: (body.projectId ?? body.project_id ?? null) as string | null,
      assigneeId: (body.assigneeId ?? body.assignee_id ?? null) as string | null,
    });
    return c.json({ issue }, 201);
  });

  routes.patch('/issues/:issueId', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const issueId = requireUuidValue(c.req.param('issueId'), 'issueId');
    const body = await readJson(c);
    return c.json({
      issue: await dependencies.store.updateIssue(organizationId, issueId, body),
    });
  });

  routes.get('/monitors', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    return c.json({ monitors: await dependencies.store.listMonitors(organizationId) });
  });

  routes.post('/monitors', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const body = await readJson(c);
    const name = readRequiredText(body.name, 'name', 200);
    const monitor = await dependencies.store.upsertMonitor(organizationId, {
      name,
      monitorType: (body.monitorType ?? body.monitor_type ?? 'service') as string,
      status: (body.status as string | undefined) ?? 'unknown',
      metadata: (body.metadata ?? body.details ?? {}) as Record<string, unknown>,
    });
    return c.json({ monitor }, 201);
  });

  routes.get('/alerts', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    return c.json({ alerts: await dependencies.store.listAlerts(organizationId) });
  });

  routes.post('/alerts', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const body = await readJson(c);
    const title = readRequiredText(body.title, 'title', 300);
    const alert = await dependencies.store.createAlert(organizationId, {
      title,
      severity: (body.severity as string | undefined) ?? 'medium',
      description: (body.description as string | null | undefined) ?? null,
      module: (body.module as string | null | undefined) ?? null,
      message: (body.message as string | null | undefined) ?? null,
    });
    return c.json({ alert }, 201);
  });

  routes.post('/alerts/:alertId/resolve', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const alertId = requireUuidValue(c.req.param('alertId'), 'alertId');
    return c.json({
      alert: await dependencies.store.resolveAlert(organizationId, alertId),
    });
  });

  routes.get('/events', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    return c.json({ events: await dependencies.store.listEvents(organizationId) });
  });

  routes.post('/events', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const body = await readJson(c);
    const eventType = readRequiredText(
      body.eventType ?? body.event_type,
      'eventType',
      120,
    );
    const event = await dependencies.store.createEvent(organizationId, {
      eventType,
      message: (body.message as string | null | undefined) ?? null,
      severity: (body.severity as string | undefined) ?? 'info',
      title: (body.title as string | null | undefined) ?? null,
      description: (body.description as string | null | undefined) ?? null,
      module: (body.module as string | null | undefined) ?? null,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? {},
    });
    return c.json({ event }, 201);
  });

  routes.get('/account-access-requests', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    return c.json({
      requests: await dependencies.store.listAccountAccessRequests(organizationId),
    });
  });

  routes.post('/account-access-requests', async (c) => {
    const auth = getAuth(c);
   
    const organizationId = requireProductOrg(auth);
    const body = await readJson(c);
    const fullName = readRequiredText(body.fullName ?? body.full_name, 'fullName', 200);
    const email = readRequiredText(body.email, 'email', 320).toLowerCase();
    const result = await dependencies.store.submitAccountAccessRequest({
      organizationId:
        (body.organizationId ?? body.organization_id ?? organizationId) as string | null,
      userId: auth.actor.userId,
      fullName,
      email,
      phone: (body.phone as string | null | undefined) ?? null,
      company: (body.company as string | null | undefined) ?? null,
      requestedRole: (body.requestedRole ?? body.requested_role ?? null) as string | null,
      message: (body.message as string | null | undefined) ?? null,
      reason: (body.reason as string | null | undefined) ?? null,
    });
    return c.json(result, 201);
  });

  routes.post('/account-access-requests/:requestId/review', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const requestId = requireUuidValue(c.req.param('requestId'), 'requestId');
    const body = await readJson(c);
    const status = String(body.status ?? '');
    if (status !== 'approved' && status !== 'rejected') {
      throw new ValidationError('status must be approved or rejected.');
    }
    const request = await dependencies.store.reviewAccountAccessRequest({
      organizationId,
      requestId,
      reviewerId: auth.actor.userId,
      status,
      notes: (body.notes ?? body.review_notes ?? null) as string | null,
    });
    return c.json({ request });
  });

  routes.get('/incidents', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    return c.json({
      incidents: await dependencies.store.listIncidents(organizationId),
    });
  });

  routes.post('/incidents', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const body = await readJson(c);
    const title = readRequiredText(body.title, 'title', 300);
    const severity = String(body.severity ?? 'medium');
    const incident = await dependencies.store.createIncident(
      organizationId,
      auth.actor.userId,
      {
        title,
        severity,
        description: (body.description as string | null | undefined) ?? null,
      },
    );
    return c.json({ incident }, 201);
  });

  routes.get('/audit-logs', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    return c.json({ logs: await dependencies.store.listAuditLogs(organizationId) });
  });


  routes.post('/admin-user-actions', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const body = await readJson(c);
    const action = String(body.action ?? '').trim();
    const targetUserId = requireUuidValue(
      String(body.targetUserId ?? body.target_user_id ?? ''),
      'targetUserId',
    );
    if (!action) throw new ValidationError('action is required.');

    const result = await dependencies.store.adminUserAction({
      organizationId,
      actorUserId: auth.actor.userId,
      action,
      targetUserId,
      newRole: (body.newRole ?? body.new_role ?? null) as string | null,
      reason: (body.reason ?? null) as string | null,
    });
    return c.json(result);
  });

  /**
   * Admin trigger: email password-reset links to workspace members.
   * Default targets users who still have no password_credentials row.
   * Use dryRun=true to preview recipients without sending.
   */
  routes.post('/password-reset-reminders', async (c) => {
    const auth = getAuth(c);
    const organizationId = await authorizePlatformIt(auth);
    const body = await readJson(c);
    const dryRun = Boolean(body.dryRun ?? body.dry_run);
    // Never email people who already have passwords unless explicitly confirmed.
    // Requesting reset does not change their hash, but it does burn prior links.
    const includeUsersWithPassword = Boolean(
      body.includeUsersWithPassword ?? body.include_users_with_password,
    );
    const onlyWithoutPassword = !includeUsersWithPassword;
    const delayMs = Math.min(
      10_000,
      Math.max(0, Number(body.delayMs ?? body.delay_ms ?? 1500) || 0),
    );

    const result = await db.query<{
      id: string;
      email: string;
      full_name: string | null;
      has_password: boolean;
    }>(
      `
        SELECT
          u.id,
          u.email,
          p.full_name,
          (c.user_id IS NOT NULL) AS has_password
        FROM identity.users u
        INNER JOIN organizations.memberships m
          ON m.user_id = u.id
         AND m.organization_id = $1
         AND m.status = 'active'
        LEFT JOIN identity.user_profiles p ON p.user_id = u.id
        LEFT JOIN identity.password_credentials c ON c.user_id = u.id
        WHERE u.deleted_at IS NULL
          AND u.email IS NOT NULL
          AND btrim(u.email) <> ''
          AND u.account_status IN ('active', 'pending', 'pending_approval')
          AND u.is_active = TRUE
        ORDER BY u.email
      `,
      [organizationId],
    );

    let targets = result.rows;
    if (onlyWithoutPassword) {
      targets = targets.filter((row) => !row.has_password);
    }

    const preview = targets.map((row) => ({
      email: row.email,
      fullName: row.full_name,
      hasPassword: row.has_password,
    }));

    if (dryRun) {
      return c.json({
        ok: true,
        dryRun: true,
        onlyWithoutPassword,
        eligible: targets.length,
        recipients: preview,
      });
    }

    let sent = 0;
    let failed = 0;
    const failures: Array<{ email: string; error: string }> = [];

    for (let i = 0; i < targets.length; i += 1) {
      const row = targets[i]!;
      try {
        await passwords.requestPasswordReset(row.email, {
          ipAddress: c.req.header('x-forwarded-for') ?? 'admin-trigger',
          userAgent: 'it-password-reset-reminders',
          requestId: c.get('requestId') as string | undefined,
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        const message =
          error instanceof Error ? error.message : String(error);
        failures.push({ email: row.email, error: message });
        logger.warn(
          {
            emailDomain: row.email.split('@')[1] ?? 'unknown',
            err: message,
          },
          'Password reset reminder delivery failed.',
        );
        if (error instanceof EmailDeliveryError && /quota/i.test(message)) {
          break;
        }
      }
      if (i < targets.length - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    await db.query(
      `INSERT INTO it.audit_logs (
         organization_id, actor_user_id, action, reason, metadata
       ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        organizationId,
        auth.actor.userId,
        'password_reset_reminders',
        `sent=${sent} failed=${failed} onlyWithoutPassword=${onlyWithoutPassword}`,
        JSON.stringify({
          sent,
          failed,
          onlyWithoutPassword,
          eligible: targets.length,
          failureEmails: failures.map((item) => item.email),
        }),
      ],
    );

    return c.json({
      ok: failed === 0,
      dryRun: false,
      onlyWithoutPassword,
      eligible: targets.length,
      sent,
      failed,
      failures,
    });
  });

  return routes;
}
