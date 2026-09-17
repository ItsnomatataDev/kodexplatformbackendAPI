import { runMigrations } from '../db/migrate.js';

runMigrations().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
