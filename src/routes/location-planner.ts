import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';
import { readJson, readRequiredText, requireUuidValue } from '../work/http.js';
import { isLocationPlannerStaff, requireProductOrg } from '../products/staff.js';
import type { PostgresLocationPlannerStore } from '../location-planner/postgres-store.js';

export type LocationPlannerRouteDependencies = { store: PostgresLocationPlannerStore };

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

export function createLocationPlannerRoutes(dependencies: LocationPlannerRouteDependencies) {
  const routes = new Hono();

  routes.get('/calendar/admin', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');
    if (!startDate || !endDate) throw new ValidationError('startDate and endDate required.');
    return c.json(await dependencies.store.getAdminCalendar({
      organizationId,
      startDate,
      endDate,
      locationId: c.req.query('locationId'),
      roleId: c.req.query('roleId'),
      employeeId: c.req.query('employeeId'),
    }));
  });

  routes.get('/calendar/me', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');
    if (!startDate || !endDate) throw new ValidationError('startDate and endDate required.');
    return c.json(await dependencies.store.getEmployeeCalendar({
      organizationId,
      userId: auth.actor.userId,
      startDate,
      endDate,
      locationId: c.req.query('locationId'),
    }));
  });

  routes.get('/locations', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({ locations: await dependencies.store.listLocations(organizationId) });
  });

  routes.post('/locations', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const body = await readJson(c);
    body.name = readRequiredText(body.name, 'name', 200);
    return c.json({ location: await dependencies.store.upsertLocation(organizationId, body) }, 201);
  });

  routes.patch('/locations/:locationId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const locationId = requireUuidValue(c.req.param('locationId'), 'locationId');
    const body = await readJson(c);
    return c.json({ location: await dependencies.store.upsertLocation(organizationId, body, locationId) });
  });

  routes.get('/roles', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({ roles: await dependencies.store.listRoles(organizationId) });
  });

  routes.post('/roles', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const body = await readJson(c);
    body.name = readRequiredText(body.name, 'name', 200);
    return c.json({ role: await dependencies.store.upsertRole(organizationId, body) }, 201);
  });

  routes.post('/slots', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const body = await readJson(c);
    return c.json({ slot: await dependencies.store.createSlot(organizationId, auth.actor.userId, body) }, 201);
  });

  routes.delete('/slots/:slotId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    await dependencies.store.deleteSlot(organizationId, requireUuidValue(c.req.param('slotId'), 'slotId'));
    return c.json({ ok: true });
  });

  routes.post('/assignments', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const body = await readJson(c);
    return c.json({ assignment: await dependencies.store.assignEmployee(organizationId, auth.actor.userId, body) }, 201);
  });

  routes.patch('/assignments/:assignmentId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const assignmentId = requireUuidValue(c.req.param('assignmentId'), 'assignmentId');
    const body = await readJson(c);
    return c.json({ assignment: await dependencies.store.updateAssignment(organizationId, assignmentId, body) });
  });

  routes.delete('/assignments/:assignmentId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    await dependencies.store.deleteAssignment(organizationId, requireUuidValue(c.req.param('assignmentId'), 'assignmentId'));
    return c.json({ ok: true });
  });

  routes.post('/off-days', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const body = await readJson(c);
    return c.json({
      offDay: await dependencies.store.setOffDay(
        organizationId,
        requireUuidValue(String(body.employeeId ?? body.employee_id ?? ''), 'employeeId'),
        String(body.offDate ?? body.off_date),
        (body.reason ?? null) as string | null,
        auth.actor.userId,
      ),
    }, 201);
  });

  routes.post('/fill-month', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isLocationPlannerStaff(auth)) throw new ForbiddenError('PLANNER_ADMIN_REQUIRED', 'Planner admin required.');
    const body = await readJson(c);
    const monthStart = readRequiredText(body.monthStart ?? body.month_start, 'monthStart', 10);
    return c.json(
      await dependencies.store.fillMonthSchedule(organizationId, auth.actor.userId, {
        monthStart,
        fromDate: (body.fromDate ?? body.from_date ?? null) as string | null,
      }),
    );
  });

  routes.post('/acknowledge-today', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json(await dependencies.store.acknowledgeToday(organizationId, auth.actor.userId));
  });

  return routes;
}
