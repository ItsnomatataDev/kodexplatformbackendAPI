import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';
import type { AuthContext } from '../authorization/types.js';
import { ForbiddenError, NotFoundError } from '../http/errors.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import type { PostgresDutyStore } from '../duty/postgres-store.js';

export type DutyRouteDependencies = {
  store: PostgresDutyStore;
};

function authorizeDuty(auth: AuthContext, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: { type: 'duty_roster', organizationId },
  });
  return organizationId;
}

function canManageDuty(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it' ||
    hasPermission(auth.membership.permissions, 'duty_roster.manage')
  );
}

function requireDutyManager(auth: AuthContext) {
  if (!canManageDuty(auth)) {
    throw new ForbiddenError(
      'DUTY_ROSTER_MANAGE_REQUIRED',
      'Only administrators, managers, and IT can manage duty rosters.',
    );
  }
  if (!auth.membership.officeId && !auth.membership.isAdminRole) {
    throw new ForbiddenError(
      'OFFICE_REQUIRED',
      'An office assignment is required to manage duty rosters.',
    );
  }
}

function requireOfficeScope(auth: AuthContext, officeId?: string | null) {
  if (auth.membership.isAdminRole) return;
  if (officeId && auth.membership.officeId && officeId !== auth.membership.officeId) {
    throw new ForbiddenError(
      'OFFICE_SCOPE_DENIED',
      'Duty rosters are scoped to your office.',
    );
  }
}

export function createDutyRoutes(dependencies: DutyRouteDependencies) {
  const routes = new Hono();

  routes.get('/rosters', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.read');
    const officeId =
      c.req.query('officeId') ??
      (!auth.membership.isAdminRole ? auth.membership.officeId : null);
    requireOfficeScope(auth, officeId);
    const rosters = await dependencies.store.listRosters(organizationId, officeId);
    return c.json({ rosters });
  });

  routes.post('/rosters', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const body = await readJson(c);
    const officeId =
      (body.officeId as string | undefined) ??
      (body.office_id as string | undefined) ??
      auth.membership.officeId ??
      null;
    requireOfficeScope(auth, officeId);
    const roster = await dependencies.store.createRoster({
      organizationId,
      officeId,
      title: readRequiredText(body.title, 'title', 200),
      department: readOptionalString(body.department, 'department', 200),
      weekStart: readRequiredText(body.weekStart ?? body.week_start, 'weekStart', 32),
      notes: readOptionalString(body.notes, 'notes', 5000),
      rotationSeed: Number(body.rotationSeed ?? body.rotation_seed ?? 0) || 0,
      createdBy: auth.actor.userId,
    });
    return c.json({ roster }, 201);
  });

  routes.patch('/rosters/:rosterId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const existing = await dependencies.store.getRoster(organizationId, rosterId);
    if (!existing) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, existing.office_id);
    const body = await readJson(c);
    const roster = await dependencies.store.updateRoster({
      organizationId,
      rosterId,
      title:
        body.title !== undefined
          ? readRequiredText(body.title, 'title', 200)
          : undefined,
      department:
        body.department !== undefined
          ? readOptionalString(body.department, 'department', 200)
          : undefined,
      notes:
        body.notes !== undefined
          ? readOptionalString(body.notes, 'notes', 5000)
          : undefined,
      status:
        body.status !== undefined
          ? readRequiredText(body.status, 'status', 32)
          : undefined,
      actorUserId: auth.actor.userId,
    });
    return c.json({ roster });
  });

  routes.delete('/rosters/:rosterId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const existing = await dependencies.store.getRoster(organizationId, rosterId);
    if (!existing) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, existing.office_id);
    await dependencies.store.deleteRoster(organizationId, rosterId);
    return c.json({ ok: true });
  });

  routes.get('/rosters/:rosterId/entries', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.read');
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const entries = await dependencies.store.listEntries(rosterId);
    return c.json({ entries });
  });

  routes.post('/rosters/:rosterId/entries', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const body = await readJson(c);
    const entry = await dependencies.store.createEntry({
      rosterId,
      userId: requireUuidValue(body.userId ?? body.user_id, 'userId'),
      shiftDate: readRequiredText(body.shiftDate ?? body.shift_date, 'shiftDate', 32),
      shiftName: readRequiredText(body.shiftName ?? body.shift_name, 'shiftName', 200),
      startTime: readOptionalString(body.startTime ?? body.start_time, 'startTime', 32),
      endTime: readOptionalString(body.endTime ?? body.end_time, 'endTime', 32),
      notes: readOptionalString(body.notes, 'notes', 2000) ?? '',
    });
    return c.json({ entry }, 201);
  });

  routes.post('/rosters/:rosterId/entries/weekly', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const body = await readJson(c);
    const entries = await dependencies.store.createWeeklyEntries({
      rosterId,
      userId: requireUuidValue(body.userId ?? body.user_id, 'userId'),
      weekStart: readRequiredText(body.weekStart ?? body.week_start, 'weekStart', 32),
      shiftName: readRequiredText(body.shiftName ?? body.shift_name, 'shiftName', 200),
      startTime: readOptionalString(body.startTime ?? body.start_time, 'startTime', 32),
      endTime: readOptionalString(body.endTime ?? body.end_time, 'endTime', 32),
      notes: readOptionalString(body.notes, 'notes', 2000) ?? '',
    });
    return c.json({ entries }, 201);
  });

  routes.get('/rosters/:rosterId/members', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.read');
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const members = await dependencies.store.listMembers(rosterId);
    return c.json({ members });
  });

  routes.put('/rosters/:rosterId/members', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const body = await readJson(c);
    const userIds = Array.isArray(body.userIds)
      ? body.userIds.map((id: unknown) => requireUuidValue(id, 'userIds'))
      : Array.isArray(body.user_ids)
        ? body.user_ids.map((id: unknown) => requireUuidValue(id, 'userIds'))
        : [];
    const members = await dependencies.store.setMembers(rosterId, userIds);
    return c.json({ members });
  });

  routes.get('/rosters/:rosterId/duties', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.read');
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const duties = await dependencies.store.listRosterDuties(rosterId);
    return c.json({ duties });
  });

  routes.put('/rosters/:rosterId/duties', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const body = await readJson(c);
    const raw = Array.isArray(body.duties) ? body.duties : [];
    const duties = await dependencies.store.setRosterDuties(
      rosterId,
      raw.map((item: unknown) => {
        if (typeof item === 'string') {
          return { dutyId: requireUuidValue(item, 'dutyId') };
        }
        const record = item as Record<string, unknown>;
        return {
          dutyId: requireUuidValue(record.dutyId ?? record.duty_id, 'dutyId'),
          assignedUserId:
            record.assignedUserId || record.assigned_user_id
              ? requireUuidValue(
                  record.assignedUserId ?? record.assigned_user_id,
                  'assignedUserId',
                )
              : null,
        };
      }),
    );
    return c.json({ duties });
  });

  routes.get('/rosters/:rosterId/assignment-history', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.read');
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const history = await dependencies.store.listAssignmentHistory({
      rosterId,
      weekStart: c.req.query('weekStart') ?? undefined,
      beforeWeek: c.req.query('beforeWeek') ?? undefined,
    });
    return c.json({ history });
  });

  routes.post('/rosters/:rosterId/assignment-history', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const rosterId = requireUuidValue(c.req.param('rosterId'), 'rosterId');
    const roster = await dependencies.store.getRoster(organizationId, rosterId);
    if (!roster) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    requireOfficeScope(auth, roster.office_id);
    const body = await readJson(c);
    const assignments = Array.isArray(body.assignments) ? body.assignments : [];
    await dependencies.store.persistAssignments(
      assignments.map((item: Record<string, unknown>) => ({
        organizationId,
        officeId: roster.office_id,
        rosterId,
        dutyId: requireUuidValue(item.dutyId ?? item.duty_id, 'dutyId'),
        userId: requireUuidValue(item.userId ?? item.user_id, 'userId'),
        assignmentWeek: readRequiredText(
          item.assignmentWeek ?? item.assignment_week,
          'assignmentWeek',
          32,
        ),
        assignmentDate:
          readOptionalString(
            item.assignmentDate ?? item.assignment_date,
            'assignmentDate',
            32,
          ) ?? null,
        source: readOptionalString(item.source, 'source', 32) ?? 'generated',
      })),
    );
    return c.json({ ok: true });
  });

  routes.get('/definitions', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.read');
    const officeId =
      c.req.query('officeId') ??
      (!auth.membership.isAdminRole ? auth.membership.officeId : null);
    requireOfficeScope(auth, officeId);
    const definitions = await dependencies.store.listDefinitions(
      organizationId,
      officeId,
    );
    return c.json({ definitions });
  });

  routes.post('/definitions', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const body = await readJson(c);
    const officeId = requireUuidValue(
      body.officeId ?? body.office_id ?? auth.membership.officeId,
      'officeId',
    );
    requireOfficeScope(auth, officeId);
    const definition = await dependencies.store.upsertDefinition({
      id: body.id ? requireUuidValue(body.id, 'id') : undefined,
      organizationId,
      officeId,
      name: readRequiredText(body.name, 'name', 200),
      description: readOptionalString(body.description, 'description', 2000),
      dutyType: body.dutyType ?? body.duty_type ?? 'weekly_rotating',
      category: body.category ?? 'normal_rotation',
      frequency: body.frequency ?? 'weekly',
      dayOfWeek: body.dayOfWeek ?? body.day_of_week ?? null,
      isActive: body.isActive ?? body.is_active ?? true,
      allowManagers: body.allowManagers ?? body.allow_managers ?? true,
      allowBosses: body.allowBosses ?? body.allow_bosses ?? true,
      fixedUserId: body.fixedUserId ?? body.fixed_user_id ?? null,
      fixedStartsAt: body.fixedStartsAt ?? body.fixed_starts_at ?? null,
      fixedEndsAt: body.fixedEndsAt ?? body.fixed_ends_at ?? null,
      fixedDutyParticipatesInFridayRotation:
        body.fixedDutyParticipatesInFridayRotation ??
        body.fixed_duty_participates_in_friday_rotation ??
        true,
      includedRoles: body.includedRoles ?? body.included_roles ?? [],
      excludedRoles: body.excludedRoles ?? body.excluded_roles ?? [],
      createdBy: auth.actor.userId,
    });

    if (Array.isArray(body.eligibilityOverrides ?? body.eligibility_overrides)) {
      const eligibility = (body.eligibilityOverrides ??
        body.eligibility_overrides) as Array<Record<string, unknown>>;
      await dependencies.store.setEligibilityOverrides(
        definition.id,
        eligibility.map((item) => ({
          userId: requireUuidValue(item.userId ?? item.user_id, 'userId'),
          isExcluded: Boolean(item.isExcluded ?? item.is_excluded),
          isForcedIncluded: Boolean(
            item.isForcedIncluded ?? item.is_forced_included,
          ),
          reason: readOptionalString(item.reason, 'reason', 500) ?? null,
        })),
      );
    }

    return c.json({ definition }, body.id ? 200 : 201);
  });

  routes.get('/eligibility-overrides', async (c) => {
    const auth = getAuth(c);
    authorizeDuty(auth, 'duty_roster.read');
    const dutyIds = (c.req.query('dutyIds') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => requireUuidValue(id, 'dutyIds'));
    const overrides = await dependencies.store.listEligibilityOverrides(dutyIds);
    return c.json({ overrides });
  });

  routes.put('/definitions/:dutyId/eligibility-overrides', async (c) => {
    const auth = getAuth(c);
    authorizeDuty(auth, 'duty_roster.manage');
    requireDutyManager(auth);
    const dutyId = requireUuidValue(c.req.param('dutyId'), 'dutyId');
    const body = await readJson(c);
    const overrides = Array.isArray(body.overrides) ? body.overrides : [];
    const saved = await dependencies.store.setEligibilityOverrides(
      dutyId,
      overrides.map((item: Record<string, unknown>) => ({
        userId: requireUuidValue(item.userId ?? item.user_id, 'userId'),
        isExcluded: Boolean(item.isExcluded ?? item.is_excluded),
        isForcedIncluded: Boolean(
          item.isForcedIncluded ?? item.is_forced_included,
        ),
        reason: readOptionalString(item.reason, 'reason', 500) ?? null,
      })),
    );
    return c.json({ overrides: saved });
  });

  routes.get('/users', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDuty(auth, 'duty_roster.read');
    const officeId =
      c.req.query('officeId') ??
      (!auth.membership.isAdminRole ? auth.membership.officeId : null);
    requireOfficeScope(auth, officeId);
    const users = await dependencies.store.listUsersForRoster(
      organizationId,
      officeId,
    );
    return c.json({ users });
  });

  return routes;
}
