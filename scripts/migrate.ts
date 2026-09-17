import { runMigrations } from '../src/db/migrate.js';

runMigrations().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
