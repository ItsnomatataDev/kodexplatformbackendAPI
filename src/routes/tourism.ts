import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { ForbiddenError } from '../http/errors.js';
import { readJson, readRequiredText } from '../work/http.js';
import { isTourismStaff, requireProductOrg } from '../products/staff.js';
import type { PostgresTourismStore } from '../tourism/postgres-store.js';

export type TourismRouteDependencies = { store: PostgresTourismStore };

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

export function createTourismRoutes(dependencies: TourismRouteDependencies) {
  const routes = new Hono();

  routes.get('/dashboard', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json(await dependencies.store.dashboard(organizationId));
  });

  routes.post('/guests', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isTourismStaff(auth)) throw new ForbiddenError('TOURISM_MANAGE_REQUIRED', 'Tourism manage required.');
    const body = await readJson(c);
    body.fullName = readRequiredText(body.fullName ?? body.full_name, 'fullName', 200);
    return c.json({ guest: await dependencies.store.createGuest(organizationId, auth.actor.userId, body) }, 201);
  });

  routes.post('/bookings', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isTourismStaff(auth)) throw new ForbiddenError('TOURISM_MANAGE_REQUIRED', 'Tourism manage required.');
    const body = await readJson(c);
    body.activityName = readRequiredText(body.activityName ?? body.activity_name, 'activityName', 200);
    return c.json({ booking: await dependencies.store.createBooking(organizationId, auth.actor.userId, body) }, 201);
  });

  routes.post('/itineraries', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isTourismStaff(auth)) throw new ForbiddenError('TOURISM_MANAGE_REQUIRED', 'Tourism manage required.');
    const body = await readJson(c);
    body.title = readRequiredText(body.title, 'title', 200);
    return c.json({ item: await dependencies.store.createItinerary(organizationId, auth.actor.userId, body) }, 201);
  });

  routes.post('/transfers', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isTourismStaff(auth)) throw new ForbiddenError('TOURISM_MANAGE_REQUIRED', 'Tourism manage required.');
    const body = await readJson(c);
    return c.json({ transfer: await dependencies.store.createTransfer(organizationId, auth.actor.userId, body) }, 201);
  });

  return routes;
}
