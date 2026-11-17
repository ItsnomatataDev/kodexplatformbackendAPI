import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { requireProductOrg } from '../products/staff.js';
import { ValidationError } from '../http/errors.js';
import { readJson, readRequiredText } from '../work/http.js';
import type { PostgresPushSubscriptionStore } from '../notifications/push-store.js';

export type PushRouteDependencies = {
  store: PostgresPushSubscriptionStore;
};

export function createPushRoutes(dependencies: PushRouteDependencies) {
  const routes = new Hono();

  routes.get('/subscriptions', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireProductOrg(auth);
    const rows = await dependencies.store.listActiveForUser(
      organizationId,
      auth.actor.userId,
    );
    return c.json({
      subscriptions: rows.map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        platform: row.platform,
        isActive: row.isActive,
        updatedAt: row.updatedAt.toISOString(),
      })),
    });
  });

  routes.post('/subscriptions', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireProductOrg(auth);
    const body = await readJson(c);
    const endpoint = readRequiredText(
      body.endpoint ?? body.token,
      'endpoint',
      512,
    );
    const platform =
      typeof body.platform === 'string' ? body.platform.trim() : 'unknown';
    const normalized = endpoint.startsWith('expo:')
      ? endpoint
      : endpoint.startsWith('ExponentPushToken[') ||
          endpoint.startsWith('ExpoPushToken[')
        ? `expo:${endpoint}`
        : endpoint;
    if (
      !normalized.startsWith('expo:ExponentPushToken[') &&
      !normalized.startsWith('expo:ExpoPushToken[')
    ) {
      throw new ValidationError(
        'endpoint must be an Expo push token (ExponentPushToken[...]).',
        { field: 'endpoint' },
      );
    }
    const row = await dependencies.store.upsert({
      organizationId,
      userId: auth.actor.userId,
      endpoint: normalized,
      platform,
    });
    return c.json(
      {
        subscription: {
          id: row.id,
          endpoint: row.endpoint,
          platform: row.platform,
          isActive: row.isActive,
        },
      },
      201,
    );
  });

  routes.delete('/subscriptions', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireProductOrg(auth);
    const deactivated = await dependencies.store.deactivateForUser({
      organizationId,
      userId: auth.actor.userId,
      endpointPrefix: 'expo:',
    });
    return c.json({ ok: true, deactivated });
  });

  return routes;
}
