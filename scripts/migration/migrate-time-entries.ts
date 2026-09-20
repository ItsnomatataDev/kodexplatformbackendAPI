import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { db } from '../../src/db/pool.js';

type LegacyRow = Record<string, string | null>;

const DEFAULT_SOURCE = path.resolve(
  process.env.LEGACY_EXPORT ??
    `${process.env.HOME}/Desktop/devprojects/POSTGRES-SERVER/backups/public-data-20260826T104827Z.sql`,
);

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function log(message: string) {
  console.log(`[time-entry-migration] ${message}`);
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function decodeCopyValue(value: string): string | null {
  if (value === '\\N') {
    return null;
  }

  let output = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\') {
      output += char;
      continue;
    }

    const next = value[i + 1];
    if (next === undefined) {
      output += '\\';
      continue;
    }

    const escapes: Record<string, string> = {
      t: '\t',
      n: '\n',
      r: '\r',
      b: '\b',
      f: '\f',
      v: '\v',
      '\\': '\\',
    };
    output += escapes[next] ?? next;
    i += 1;
  }

  return output;
}

function extractCopyRows(sql: string, tableName: string): LegacyRow[] {
  const lines = sql.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    line.startsWith(`COPY public.${tableName} (`),
  );

  if (headerIndex === -1) {
    throw new Error(`COPY block not found for public.${tableName}`);
  }

  const match = lines[headerIndex].match(
    new RegExp(`^COPY public\\.${tableName} \\((.+)\\) FROM stdin;$`),
  );
  if (!match) {
    throw new Error(`Unable to parse COPY header for public.${tableName}`);
  }

  const columns = match[1].split(',').map((column) => column.trim().replace(/"/g, ''));
  const rows: LegacyRow[] = [];

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '\\.') break;
    if (!line) continue;

    const values = line.split('\t');
    if (values.length !== columns.length) {
      throw new Error(
        `Column mismatch in public.${tableName} at source line ${i + 1}`,
      );
    }

    const row: LegacyRow = {};
    columns.forEach((column, index) => {
      row[column] = decodeCopyValue(values[index]);
    });
    rows.push(row);
  }

  return rows;
}

function booleanValue(value: string | null, fallback = false) {
  if (value === null) return fallback;
  return value === 't' || value === 'true';
}

function integerValue(value: string | null, fallback = 0) {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadExisting(client: PoolClient) {
  const orgs = await client.query<{ id: string }>(
    'SELECT id FROM organizations.organizations',
  );
  const users = await client.query<{ id: string }>('SELECT id FROM identity.users');
  const cards = await client.query<{ id: string }>('SELECT id FROM work.cards');

  return {
    organizations: new Set(orgs.rows.map((row) => row.id)),
    users: new Set(users.rows.map((row) => row.id)),
    cards: new Set(cards.rows.map((row) => row.id)),
  };
}

async function insertTimeEntries(
  client: PoolClient,
  rows: LegacyRow[],
  existing: { organizations: Set<string>; users: Set<string>; cards: Set<string> },
) {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.id || !row.task_id || !row.user_id || !row.organization_id) {
      skipped += 1;
      continue;
    }
    if (row.deleted_at) {
      skipped += 1;
      continue;
    }
    if (
      !existing.cards.has(row.task_id) ||
      !existing.users.has(row.user_id) ||
      !existing.organizations.has(row.organization_id)
    ) {
      skipped += 1;
      continue;
    }

    const isRunning = booleanValue(row.is_running);
    const seconds = Math.max(0, integerValue(row.duration_seconds));
    const note = row.description?.trim() || null;

    await client.query(
      `
        INSERT INTO work.time_entries (
          id, card_id, organization_id, user_id, created_by, seconds, note,
          started_at, ended_at, is_billable, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$4,$5,$6,
          $7::timestamptz,
          $8::timestamptz,
          $9,
          COALESCE($10::timestamptz, NOW()),
          COALESCE($11::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          seconds = EXCLUDED.seconds,
          note = EXCLUDED.note,
          started_at = EXCLUDED.started_at,
          ended_at = EXCLUDED.ended_at,
          is_billable = EXCLUDED.is_billable,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.task_id,
        row.organization_id,
        row.user_id,
        seconds,
        note,
        row.started_at,
        isRunning ? null : row.ended_at,
        booleanValue(row.is_billable),
        row.created_at,
        row.updated_at,
      ],
    );
    imported += 1;
  }

  return { imported, skipped };
}

async function refreshTrackedSeconds(client: PoolClient) {
  await client.query(`
    UPDATE work.cards card
    SET tracked_seconds_cache = COALESCE((
      SELECT SUM(entry.seconds)
      FROM work.time_entries entry
          WHERE entry.organization_id = card.organization_id
            AND entry.card_id = card.id
            AND entry.deleted_at IS NULL
    ), 0)
  `);
}

async function main() {
  log(`Source: ${DEFAULT_SOURCE}`);
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  if (!fs.existsSync(DEFAULT_SOURCE)) {
    fail(`Legacy export does not exist: ${DEFAULT_SOURCE}`);
  }

  const sql = fs.readFileSync(DEFAULT_SOURCE, 'utf8');
  const entries = extractCopyRows(sql, 'time_entries');

  console.log('\n========================================');
  console.log('TIME ENTRY MIGRATION');
  console.log('========================================');
  console.log(`Time entries: ${entries.length}`);
  console.log('========================================\n');

  if (!apply) {
    log('Dry run complete. No target data was written.');
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await loadExisting(client);
    const result = await insertTimeEntries(client, entries, existing);
    log(`Time entries imported: ${result.imported} (skipped ${result.skipped})`);
    await refreshTrackedSeconds(client);
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
