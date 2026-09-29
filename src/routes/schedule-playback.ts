import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { isUuid } from '../auth/uuid.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { PostgresSchedulePlaybackStore, type SchedulePlaybackStore } from '../content/schedule-playback-store.js';
import { defaultPlaybackSigner, type PlaybackSigner } from '../content/schedule-playback-signer.js';

export function createSchedulePlaybackRoutes(dependencies: {
  store?: SchedulePlaybackStore;
  sign?: PlaybackSigner;
} = {}) {
  const store = dependencies.store ?? new PostgresSchedulePlaybackStore();
  const sign = dependencies.sign ?? defaultPlaybackSigner();
  const routes = new Hono();

  routes.get('/:scheduleId/playback', async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    assertAuthorized({ context: auth, action: 'content_studio.read',
      resource: { type: 'content_studio', organizationId } });

    const scheduleId = c.req.param('scheduleId');
    const finishedIds = c.req.queries('currentAssetId');
    const finishedId = finishedIds?.[0] ?? null;
    if (!isUuid(scheduleId) || (finishedId !== null && !isUuid(finishedId)) ||
        (finishedIds && finishedIds.length !== 1)) {
      throw new ValidationError('scheduleId and currentAssetId must be single UUID values.');
    }

    const selection = await store.select(organizationId, scheduleId, finishedId);
    if (!selection.schedule_exists) {
      throw new NotFoundError('SCHEDULE_NOT_FOUND', 'Schedule was not found.');
    }
    if (!selection.anchor_exists) {
      throw new NotFoundError('ASSET_NOT_FOUND', 'Finished asset does not belong to this schedule.');
    }
    const assets = await Promise.all(selection.assets.map(sign));
    return c.json({ currentAsset: assets[0] ?? null, nextAsset: assets[1] ?? null });
  });
  return routes;
}
