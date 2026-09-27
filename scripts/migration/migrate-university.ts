/**
 * Seed Kode University curriculum from the Supabase migration SQL seeds
 * (live Supabase no longer exposes university_* tables).
 *
 * Usage:
 *   npx tsx scripts/migration/migrate-university.ts            # dry run
 *   npx tsx scripts/migration/migrate-university.ts --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../src/db/pool.js';

const apply = process.argv.includes('--apply');

const MIGRATIONS_DIR = path.resolve(
  `${process.env.HOME}/Desktop/devprojects/ITsNomatataWorkSpace/supabase/migrations`,
);

const SEED_FILES = [
  'university_module.sql',
  'university_deep_curriculum.sql',
  'university_role_curriculum.sql',
  'university_assets_fleet_deep.sql',
];

function log(message: string) {
  console.log(`[university-migration] ${message}`);
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function rewriteUniversitySql(sql: string): string {
  let text = sql
    .replace(/public\.university_modules/g, 'university.modules')
    .replace(/public\.university_topics/g, 'university.topics')
    .replace(/public\.university_topic_progress/g, 'university.topic_progress');

  // Drop feature-flag insert (different shape in Kode).
  text = text.replace(
    /insert into public\.organization_features[\s\S]*?updated_at = now\(\);\s*/i,
    '',
  );

  // Prefer starting at the first data statement so DDL/RLS/functions are skipped
  // when present (university_module.sql). Deep curriculum files are data-only.
  const dataStart = text.search(
    /\n(?:insert into university\.|update university\.|do \$\$|delete from university\.)/i,
  );
  if (dataStart >= 0) {
    text = text.slice(dataStart + 1);
  }

  return text.trim();
}

async function main() {
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  const statements: { file: string; sql: string }[] = [];
  for (const file of SEED_FILES) {
    const fullPath = path.join(MIGRATIONS_DIR, file);
    if (!fs.existsSync(fullPath)) {
      log(`Skip missing seed: ${file}`);
      continue;
    }
    const rewritten = rewriteUniversitySql(fs.readFileSync(fullPath, 'utf8'));
    if (!rewritten) {
      log(`Skip empty rewrite: ${file}`);
      continue;
    }
    statements.push({ file, sql: rewritten });
    log(`Prepared ${file} (${rewritten.length} chars)`);
  }

  if (statements.length === 0) {
    fail('No university seed files found to apply.');
  }

  if (!apply) {
    log('Dry run complete. No target data was written.');
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) {
      log(`Applying ${statement.file}...`);
      await client.query(statement.sql);
    }
    const counts = await client.query<{
      modules: string;
      topics: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM university.modules) AS modules,
        (SELECT count(*)::text FROM university.topics) AS topics
    `);
    log(
      `Seeded modules=${counts.rows[0]?.modules ?? '0'} topics=${counts.rows[0]?.topics ?? '0'}`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
