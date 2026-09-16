import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { env } from './config/env.js';

const app = createApp();

console.log(`Kode Platform API starting on http://${env.host}:${env.port}`);

serve({
  fetch: app.fetch,
  hostname: env.host,
  port: env.port,
});
