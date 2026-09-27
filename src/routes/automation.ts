import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { requireProductOrg } from '../products/staff.js';
import {
  readJson,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import type { PostgresAiStore } from '../ai/postgres-store.js';
import { readListQuery } from '../http/list-query.js';

export type AutomationRouteDependencies = {
  store: PostgresAiStore;
};

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

function buildDefinitionFromBody(body: Record<string, unknown>) {
  const definition: Record<string, unknown> =
    body.definition && typeof body.definition === 'object' && !Array.isArray(body.definition)
      ? { ...(body.definition as Record<string, unknown>) }
      : {};

  if (body.slug !== undefined) definition.slug = body.slug;
  if (body.description !== undefined) definition.description = body.description;
  if (body.webhook_url !== undefined || body.webhookUrl !== undefined) {
    definition.webhook_url = body.webhook_url ?? body.webhookUrl ?? null;
  }
  if (body.project_id !== undefined || body.projectId !== undefined) {
    definition.project_id = body.project_id ?? body.projectId ?? null;
  }
  if (body.status !== undefined) definition.status = body.status;

  return definition;
}

export function createAutomationRoutes(dependencies: AutomationRouteDependencies) {
  const routes = new Hono();

  routes.get('/flows', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const page = await dependencies.store.listFlows(organizationId, readListQuery(c));
    return c.json({ flows: page.flows, hasMore: page.hasMore });
  });

  routes.post('/flows', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const name = readRequiredText(body.name, 'name', 200);
    const definition = buildDefinitionFromBody(body);
    const status = String(body.status ?? definition.status ?? 'active');
    const enabled =
      body.enabled === undefined
        ? status !== 'disabled' && status !== 'inactive'
        : Boolean(body.enabled);

    const flow = await dependencies.store.createFlow(
      organizationId,
      auth.actor.userId,
      { name, definition, enabled },
    );
    return c.json({ flow }, 201);
  });

  routes.get('/flows/:flowId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const flowId = requireUuidValue(c.req.param('flowId'), 'flowId');
    return c.json({
      flow: await dependencies.store.getFlow(organizationId, flowId),
    });
  });

  routes.patch('/flows/:flowId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const flowId = requireUuidValue(c.req.param('flowId'), 'flowId');
    const body = await readJson(c);
    const definition = buildDefinitionFromBody(body);
    const enabled =
      body.enabled === undefined
        ? body.status === undefined
          ? undefined
          : String(body.status) !== 'disabled' && String(body.status) !== 'inactive'
        : Boolean(body.enabled);

    return c.json({
      flow: await dependencies.store.updateFlow(organizationId, flowId, {
        name:
          body.name === undefined
            ? undefined
            : readRequiredText(body.name, 'name', 200),
        definition: Object.keys(definition).length > 0 ? definition : undefined,
        enabled,
      }),
    });
  });

  routes.delete('/flows/:flowId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const flowId = requireUuidValue(c.req.param('flowId'), 'flowId');
    await dependencies.store.deleteFlow(organizationId, flowId);
    return c.body(null, 204);
  });

  routes.post('/flows/:flowId/run', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const flowId = requireUuidValue(c.req.param('flowId'), 'flowId');
    const body = await readJson(c).catch(() => ({} as Record<string, unknown>));
    const payload =
      body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : (body as Record<string, unknown>);

    const run = await dependencies.store.startRun(
      organizationId,
      auth.actor.userId,
      flowId,
      { payload },
    );
    return c.json({ run }, 201);
  });

  routes.get('/runs', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const flowId = c.req.query('flowId') ?? c.req.query('flow_id') ?? null;
    const page = await dependencies.store.listRuns(
      organizationId,
      flowId,
      readListQuery(c),
    );
    return c.json({ runs: page.runs, hasMore: page.hasMore });
  });

  routes.get('/runs/:runId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const runId = requireUuidValue(c.req.param('runId'), 'runId');
    return c.json({
      run: await dependencies.store.getRun(organizationId, runId),
    });
  });

  return routes;
}
