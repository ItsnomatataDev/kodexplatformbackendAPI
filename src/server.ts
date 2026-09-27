import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { db } from './db/pool.js';
import { closeAllRedisRateLimiters } from './auth/rate-limit-redis.js';
import { getChatRealtimeHub } from './chat/hub.js';
import { startAttendanceScheduler } from './attendance/scheduler.js';

const app = createApp();
const wss = new WebSocketServer({ noServer: true });

const server = serve({
  fetch: app.fetch,
  hostname: env.host,
  port: env.port,
  websocket: { server: wss },
}) as ServerType;

const stopAttendanceScheduler = startAttendanceScheduler();

void getChatRealtimeHub()
  .start()
  .catch((error) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Chat realtime hub failed to start',
    );
  });

logger.info(
  {
    host: env.host,
    port: env.port,
    appEnv: env.appEnv,
    websocket: true,
  },
  'Kode Platform API started',
);

function closeHttpServer() {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, 'Shutting down Kode Platform API');

  try {
    stopAttendanceScheduler();
    await getChatRealtimeHub().stop();
    await closeHttpServer();
    await closeAllRedisRateLimiters();
    await db.end();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
