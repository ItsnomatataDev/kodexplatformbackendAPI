import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { db } from './db/pool.js';

const app = createApp();

const server = serve({
  fetch: app.fetch,
  hostname: env.host,
  port: env.port,
});

logger.info(
  {
    host: env.host,
    port: env.port,
    appEnv: env.appEnv,
  },
  'Kode Platform API started',
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down Kode Platform API');

  server.close();
  await db.end();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
