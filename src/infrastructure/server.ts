import { serve } from '@hono/node-server';
import { readInfrastructureConfig } from './config.js';
import { infrastructurePool, checkDatabaseRole } from './db/pool.js';
import { createInfrastructureApp } from './app.js';
async function main() {
  const config = readInfrastructureConfig();
  const pool = infrastructurePool(config);
  await checkDatabaseRole(pool, 'kode_infra_runtime');
  const server = serve({
    fetch: createInfrastructureApp(config, pool).fetch,
    hostname: config.host,
    port: config.port,
  });
  console.info('Kodex infrastructure runtime started');
  const stop = () =>
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
main().catch(() => {
  console.error(
    'Infrastructure startup failed; check dedicated configuration and database role',
  );
  process.exit(1);
});
