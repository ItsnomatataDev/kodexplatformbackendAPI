import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  createRedisPlaybackGrantStore,
  type PlaybackGrantStore,
} from './redis-grant.js';

let store: PlaybackGrantStore | undefined;

export function sharedPlaybackGrantStore(): PlaybackGrantStore {
  if (!store) {
    store = createRedisPlaybackGrantStore({
      appEnv: env.appEnv,
      host: env.redis.host,
      port: env.redis.port,
      username: env.redis.username,
      password: env.redis.password,
      tls: env.redis.tls,
      rejectUnauthorized: env.redis.rejectUnauthorized,
      ca: env.redis.ca,
    });
  }
  return store;
}

export async function revokePlaybackGrantsForUser(userId: string) {
  if (!process.env.MEDIA_PLAYBACK_SIGNING_SECRET) return;
  try {
    await sharedPlaybackGrantStore().revokeUser(userId);
  } catch (err) {
    logger.error({ err, userId }, 'Failed to revoke media playback grants');
  }
}
