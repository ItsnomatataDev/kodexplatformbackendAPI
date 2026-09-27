import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { ForbiddenError } from '../http/errors.js';
import { readJson, requireUuidValue } from '../work/http.js';
import { isAdminManagerIt, requireProductOrg } from '../products/staff.js';
import type { PostgresUniversityStore } from '../university/postgres-store.js';

export type UniversityRouteDependencies = { store: PostgresUniversityStore };

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

export function createUniversityRoutes(dependencies: UniversityRouteDependencies) {
  const routes = new Hono();

  routes.get('/modules', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    return c.json({ modules: await dependencies.store.listModules() });
  });

  routes.get('/topics', async (c) => {
    const auth = getAuth(c);
    authorize(auth);
    return c.json({ topics: await dependencies.store.listTopics(c.req.query('moduleId') ?? undefined) });
  });

  routes.get('/progress/me', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({
      progress: await dependencies.store.listProgress(organizationId, auth.actor.userId),
    });
  });

  routes.post('/topics/:topicId/complete', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const topicId = requireUuidValue(c.req.param('topicId'), 'topicId');
    const body = await readJson(c).catch(() => ({} as Record<string, unknown>));
    return c.json({
      result: await dependencies.store.completeTopic(
        organizationId,
        auth.actor.userId,
        topicId,
        (body.attestationNote ?? body.attestation_note ?? null) as string | null,
      ),
    });
  });

  routes.get('/progress/org', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isAdminManagerIt(auth) && auth.membership.roleKey !== 'hr') {
      throw new ForbiddenError('UNIVERSITY_ADMIN_REQUIRED', 'University admin access required.');
    }
    return c.json({ users: await dependencies.store.listOrgProgress(organizationId) });
  });

  routes.get('/progress/users/:userId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const userId = requireUuidValue(c.req.param('userId'), 'userId');
    if (
      userId !== auth.actor.userId &&
      !isAdminManagerIt(auth) &&
      auth.membership.roleKey !== 'hr'
    ) {
      throw new ForbiddenError('UNIVERSITY_ADMIN_REQUIRED', 'University admin access required.');
    }
    return c.json({
      progress: await dependencies.store.listProgress(organizationId, userId),
    });
  });

  return routes;
}
