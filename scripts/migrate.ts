import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { db } from '../src/db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../migrations');

function parseMigrationFilename(file: string) {
  const match = file.match(/^(\d{4})_([\w-]+)\.sql$/);

  if (!match) {
    throw new Error(`Invalid migration filename: ${file}`);
  }

  return {
    version: match[1],
    description: match[2],
  };
}

async function ensureMigrationTable() {
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS platform;

    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations() {
  const result = await db.query<{ version: string }>(`
    SELECT version
    FROM platform.schema_migrations
    ORDER BY version
  `);

  return new Set(result.rows.map((row) => row.version));
}

function assertConsecutiveVersions(files: string[]) {
  files.forEach((file, index) => {
    const expected = String(index + 1).padStart(4, '0');
    const { version } = parseMigrationFilename(file);

    if (version !== expected) {
      throw new Error(
        `Migration versions must be consecutive. Expected ${expected}_*.sql, found ${file}`,
      );
    }
  });
}

async function run() {
  console.log(`Applying migrations for APP_ENV=${env.appEnv}`);

  await ensureMigrationTable();

  const applied = await getAppliedMigrations();

  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationsDir}`);
  }

  assertConsecutiveVersions(files);

  const fileVersions = new Set(
    files.map((file) => parseMigrationFilename(file).version),
  );

  for (const version of applied) {
    if (!fileVersions.has(version)) {
      throw new Error(
        `Applied migration ${version} is missing from the migrations directory.`,
      );
    }
  }

  let appliedNow = 0;

  for (const file of files) {
    const { version, description } = parseMigrationFilename(file);

    if (applied.has(version)) {
      console.log(`Skipping ${file} (already applied)`);
      continue;
    }

    const sql = await fs.readFile(
      path.join(migrationsDir, file),
      'utf8',
    );

    console.log(`Applying ${file}...`);

    const client = await db.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);

      await client.query(
        `
        INSERT INTO platform.schema_migrations
          (version, description)
        VALUES ($1, $2)
        `,
        [version, description],
      );

      await client.query('COMMIT');

      appliedNow += 1;
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed ${file}`);
      throw error;
    } finally {
      client.release();
    }
  }

  await db.end();

  console.log(
    `Database migrations complete. applied=${appliedNow} already_present=${applied.size} total=${files.length}`,
  );
}

run().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
