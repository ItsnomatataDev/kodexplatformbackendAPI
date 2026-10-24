import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { listOffset } from '../db/list-bounds.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';
import { readListQuery } from '../http/list-query.js';
import { readJson, readOptionalString, readRequiredText, requireUuidValue } from '../work/http.js';
import { isAdminManagerIt, requireProductOrg } from '../products/staff.js';
import type { PostgresObligationsStore } from '../obligations/postgres-store.js';

export type ObligationsRouteDependencies = { store: PostgresObligationsStore };

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

export function createObligationsRoutes(dependencies: ObligationsRouteDependencies) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const assigneeQuery = c.req.query('assigneeId');
    const assigneeId = assigneeQuery === undefined ? undefined : requireUuidValue(assigneeQuery, 'assigneeId');
    const includeArchived = c.req.query('includeArchived') === 'true';
    if (assigneeId && assigneeId !== auth.actor.userId && !isAdminManagerIt(auth)) {
      throw new ForbiddenError('OBLIGATIONS_ADMIN_REQUIRED', 'Admin access required.');
    }
    const page = readListQuery(c);
    const rows = await dependencies.store.listWithCurrentOccurrence(
      organizationId,
      assigneeId ?? (isAdminManagerIt(auth) ? null : auth.actor.userId),
      includeArchived && isAdminManagerIt(auth),
      {
        limit: page.limit,
        offset: listOffset(Number(c.req.query('offset'))),
      },
    );
    return c.json({ obligations: rows.obligations, hasMore: rows.hasMore });
  });

  routes.get('/dashboard', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const page = readListQuery(c);
    const rows = await dependencies.store.listWithCurrentOccurrence(
      organizationId,
      auth.actor.userId,
      false,
      {
        limit: page.limit,
        offset: listOffset(Number(c.req.query('offset'))),
        openOnly: true,
      },
    );
    return c.json({ obligations: rows.obligations, hasMore: rows.hasMore });
  });

  routes.get('/calendar', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const rangeStart = c.req.query('rangeStart');
    const rangeEnd = c.req.query('rangeEnd');
    if (!rangeStart || !rangeEnd) throw new ValidationError('rangeStart and rangeEnd required.');
    const assigneeQuery = c.req.query('assigneeId');
    const assigneeId = assigneeQuery === undefined
      ? (isAdminManagerIt(auth) ? null : auth.actor.userId)
      : requireUuidValue(assigneeQuery, 'assigneeId');
    if (assigneeId && assigneeId !== auth.actor.userId && !isAdminManagerIt(auth)) {
      throw new ForbiddenError('OBLIGATIONS_ADMIN_REQUIRED', 'Admin access required.');
    }
    return c.json({
      occurrences: await dependencies.store.listOccurrencesInRange(
        organizationId,
        rangeStart.slice(0, 10),
        rangeEnd.slice(0, 10),
        assigneeId,
      ),
    });
  });

  routes.post('/', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isAdminManagerIt(auth)) throw new ForbiddenError('OBLIGATIONS_ADMIN_REQUIRED', 'Admin access required.');
    const body = await readJson(c);
    const obligation = await dependencies.store.create({
      organizationId,
      title: readRequiredText(body.title, 'title', 200),
      description: (body.description ?? null) as string | null,
      dueDayOfMonth: Number(body.dueDayOfMonth ?? body.due_day_of_month),
      assigneeId: requireUuidValue(String(body.assigneeId ?? body.assignee_id ?? ''), 'assigneeId'),
      createdBy: auth.actor.userId,
    });
    return c.json({ obligation }, 201);
  });

  routes.get('/:obligationId/handovers', async (c) => {
    const auth = getAuth(c);
    const page = readListQuery(c);
    return c.json(await dependencies.store.listHandovers({
      organizationId: authorize(auth),
      obligationId: requireUuidValue(c.req.param('obligationId'), 'obligationId'),
      actorUserId: auth.actor.userId,
      canManage: isAdminManagerIt(auth),
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    }));
  });

  routes.post('/:obligationId/handover', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    return c.json(await dependencies.store.handover({
      organizationId: authorize(auth),
      obligationId: requireUuidValue(c.req.param('obligationId'), 'obligationId'),
      actorUserId: auth.actor.userId,
      assigneeId: requireUuidValue(String(body.assigneeId ?? body.assignee_id ?? ''), 'assigneeId'),
      canManage: isAdminManagerIt(auth),
      note: readOptionalString(body.note, 'note', 2000),
    }));
  });

  routes.patch('/:obligationId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isAdminManagerIt(auth)) throw new ForbiddenError('OBLIGATIONS_ADMIN_REQUIRED', 'Admin access required.');
    const obligationId = requireUuidValue(c.req.param('obligationId'), 'obligationId');
    const body = await readJson(c);
    const assignee = body.assigneeId ?? body.assignee_id;
    const obligation = await dependencies.store.update(obligationId, organizationId, {
      title: body.title,
      description: body.description,
      dueDayOfMonth: body.dueDayOfMonth ?? body.due_day_of_month,
      assigneeId: assignee === undefined ? undefined : requireUuidValue(String(assignee), 'assigneeId'),
      isActive: body.isActive ?? body.is_active,
    }, auth.actor.userId);
    return c.json({ obligation });
  });

  routes.post('/occurrences/:occurrenceId/submit', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const occurrenceId = requireUuidValue(c.req.param('occurrenceId'), 'occurrenceId');
    const body = await readJson(c);
    const occurrence = await dependencies.store.submitOccurrence(
      occurrenceId,
      auth.actor.userId,
      readOptionalString(body.note, 'note', 2000),
      organizationId,
    );
    return c.json({ occurrence });
  });

  return routes;
}
