import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';
import { readJson, readRequiredText, requireUuidValue } from '../work/http.js';
import { isMediaStaff, requireProductOrg } from '../products/staff.js';
import type { PostgresSocialStore } from '../social/postgres-store.js';

export type SocialRouteDependencies = { store: PostgresSocialStore };

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

export function createSocialRoutes(dependencies: SocialRouteDependencies) {
  const routes = new Hono();

  routes.get('/posts', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const before = c.req.query('before') ?? undefined;
    const beforeId = c.req.query('beforeId') ?? undefined;
    if (Boolean(before) !== Boolean(beforeId)) {
      throw new ValidationError('before and beforeId must be provided together.');
    }
    if (before && Number.isNaN(Date.parse(before))) {
      throw new ValidationError('before must be a timestamp.', { field: 'before' });
    }
    if (beforeId) requireUuidValue(beforeId, 'beforeId');
    const page = await dependencies.store.list(organizationId, {
      clientId: c.req.query('clientId') ?? undefined,
      campaignId: c.req.query('campaignId') ?? undefined,
      status: c.req.query('status') ?? undefined,
      beforeCreatedAt: before,
      beforeId,
    });
    return c.json({ posts: page.posts, hasMore: page.hasMore });
  });

  routes.post('/posts', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isMediaStaff(auth)) throw new ForbiddenError('SOCIAL_MANAGE_REQUIRED', 'Social manage required.');
    const body = await readJson(c);
    body.title = readRequiredText(body.title, 'title', 200);
    body.platform = readRequiredText(body.platform, 'platform', 40);
    return c.json({ post: await dependencies.store.create(organizationId, auth.actor.userId, body) }, 201);
  });

  routes.patch('/posts/:postId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isMediaStaff(auth)) throw new ForbiddenError('SOCIAL_MANAGE_REQUIRED', 'Social manage required.');
    const postId = requireUuidValue(c.req.param('postId'), 'postId');
    const body = await readJson(c);
    return c.json({ post: await dependencies.store.update(organizationId, postId, body) });
  });

  routes.delete('/posts/:postId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    if (!isMediaStaff(auth)) throw new ForbiddenError('SOCIAL_MANAGE_REQUIRED', 'Social manage required.');
    await dependencies.store.delete(organizationId, requireUuidValue(c.req.param('postId'), 'postId'));
    return c.json({ ok: true });
  });

  return routes;
}
