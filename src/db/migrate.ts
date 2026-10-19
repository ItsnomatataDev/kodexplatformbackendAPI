import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import path from 'node:path';
import { env } from '../config/env.js';
import { db } from './pool.js';
import { migrationBody, planMigrations, type AppliedMigration } from './migration-plan.js';

export async function applyMigrations(client: Pick<PoolClient, 'query'>, directory: string): Promise<string[]> {
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.sql'));
  if (!files.length) throw new Error('No SQL migrations found');
  // Validate filenames before opening a connection or creating the ledger.
  planMigrations(files, []);
  try {
    await client.query('SELECT pg_advisory_lock(71402820)');
    await client.query(`CREATE SCHEMA IF NOT EXISTS platform;
      CREATE TABLE IF NOT EXISTS platform.schema_migrations (
        version VARCHAR(255) PRIMARY KEY, description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const history = await client.query<AppliedMigration>('SELECT version, description FROM platform.schema_migrations');
    const pending = planMigrations(files, history.rows);
    console.log(`Applying ${pending.length} migrations for APP_ENV=${env.appEnv}`);
    for (const migration of pending) {
      const sql = migrationBody(await fs.readFile(path.join(directory, migration.filename), 'utf8'));
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL statement_timeout = 0');
        await client.query(sql);
        // Full filenames disambiguate new entries from existing numeric 0058 rows.
        // Never UPDATE/DELETE or backdate an existing history entry.
        await client.query('INSERT INTO platform.schema_migrations(version, description) VALUES ($1,$2)',
          [migration.filename, migration.description]);
        await client.query('COMMIT');
        console.log(`Applied ${migration.filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return pending.map(migration => migration.filename);
  } finally {
    await client.query('SELECT pg_advisory_unlock(71402820)').catch(() => {});
  }
}

export async function runMigrations() {
  const client = await db.connect();
  try {
    await applyMigrations(client, path.resolve(process.env.MIGRATIONS_DIR ?? 'migrations'));
  } finally {
    client.release();
    await db.end();
  }
}
