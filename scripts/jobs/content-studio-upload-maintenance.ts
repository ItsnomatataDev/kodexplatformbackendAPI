import { db } from '../../src/db/pool.js';
import { logger } from '../../src/config/logger.js';
import { runContentStudioUploadMaintenance } from '../../src/content/resumable/maintenance.js';

async function main() {
  const { failures } = await runContentStudioUploadMaintenance();
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    logger.error({ err: error }, 'content_studio_upload_maintenance_failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
