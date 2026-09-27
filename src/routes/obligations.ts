import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { listOffset } from '../db/list-bounds.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';
import { readListQuery } from '../http/list-query.js';
import { readJson, readRequiredText, requireUuidValue } from '../work/http.js';
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
    const assigneeId = c.req.query('assigneeId');
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
    const assigneeId = c.req.query('assigneeId') ?? (isAdminManagerIt(auth) ? null : auth.actor.userId);
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

  routes.patch('/:obligationId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isAdminManagerIt(auth)) throw new ForbiddenError('OBLIGATIONS_ADMIN_REQUIRED', 'Admin access required.');
    const obligationId = requireUuidValue(c.req.param('obligationId'), 'obligationId');
    const body = await readJson(c);
    const obligation = await dependencies.store.update(obligationId, organizationId, {
      title: body.title,
      description: body.description,
      dueDayOfMonth: body.dueDayOfMonth ?? body.due_day_of_month,
      assigneeId: body.assigneeId ?? body.assignee_id,
      isActive: body.isActive ?? body.is_active,
    });
    return c.json({ obligation });
  });

  routes.post('/occurrences/:occurrenceId/submit', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    const occurrenceId = requireUuidValue(c.req.param('occurrenceId'), 'occurrenceId');
    const body = await readJson(c);
    const occurrence = await dependencies.store.submitOccurrence(
      occurrenceId,
      auth.actor.userId,
      (body.note ?? null) as string | null,
    );
    return c.json({ occurrence });
  });

  return routes;
}
