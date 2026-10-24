import { db } from '../../db/pool.js';
import { logger } from '../../config/logger.js';
import { runContentStudioUploadMaintenance } from './maintenance.js';

function maintenanceIntervalMs() {
  const seconds = Number(
    process.env.CONTENT_STUDIO_UPLOAD_MAINTENANCE_INTERVAL_SECONDS ?? '0',
  );
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(Math.trunc(seconds) * 1000, 60 * 60 * 1000);
}

async function main() {
  const intervalMs = maintenanceIntervalMs();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  do {
    const { failures } = await runContentStudioUploadMaintenance();
    if (intervalMs <= 0) {
      if (failures > 0) process.exitCode = 1;
      return;
    }
    const started = Date.now();
    while (!stopping && Date.now() - started < intervalMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } while (!stopping);
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'content_studio_upload_maintenance_failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
