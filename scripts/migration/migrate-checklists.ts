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
  console.log(`[checklist-migration] ${message}`);
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

async function insertChecklists(
  client: PoolClient,
  rows: LegacyRow[],
  existing: { organizations: Set<string>; users: Set<string>; cards: Set<string> },
) {
  const imported = new Set<string>();
  let skipped = 0;

  for (const row of rows) {
    if (!row.id || !row.task_id || !row.organization_id || !row.title) {
      skipped += 1;
      continue;
    }
    if (!existing.cards.has(row.task_id) || !existing.organizations.has(row.organization_id)) {
      skipped += 1;
      continue;
    }

    const createdBy =
      row.created_by && existing.users.has(row.created_by) ? row.created_by : null;

    await client.query(
      `
        INSERT INTO work.card_checklists (
          id, card_id, organization_id, created_by, title, position,
          created_at, updated_at, legacy_source, legacy_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          COALESCE($7::timestamptz, NOW()),
          COALESCE($8::timestamptz, NOW()),
          'supabase',$1
        )
        ON CONFLICT (legacy_source, legacy_id) DO UPDATE SET
          title = EXCLUDED.title,
          position = EXCLUDED.position,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.task_id,
        row.organization_id,
        createdBy,
        row.title,
        Math.max(0, integerValue(row.position)),
        row.created_at,
        row.updated_at,
      ],
    );
    imported.add(row.id);
  }

  return { imported, skipped };
}

async function insertItems(
  client: PoolClient,
  rows: LegacyRow[],
  checklistIds: Set<string>,
  existing: { organizations: Set<string>; users: Set<string>; cards: Set<string> },
) {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (
      !row.id ||
      !row.checklist_id ||
      !row.task_id ||
      !row.organization_id ||
      !row.content
    ) {
      skipped += 1;
      continue;
    }
    if (
      !checklistIds.has(row.checklist_id) ||
      !existing.cards.has(row.task_id) ||
      !existing.organizations.has(row.organization_id)
    ) {
      skipped += 1;
      continue;
    }

    const createdBy =
      row.created_by && existing.users.has(row.created_by) ? row.created_by : null;
    const completedBy =
      row.completed_by && existing.users.has(row.completed_by)
        ? row.completed_by
        : null;
    const isCompleted = booleanValue(row.is_completed);

    await client.query(
      `
        INSERT INTO work.card_checklist_items (
          id, checklist_id, card_id, organization_id, created_by, completed_by,
          content, is_completed, completed_at, position, created_at, updated_at,
          legacy_source, legacy_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9::timestamptz,$10,
          COALESCE($11::timestamptz, NOW()),
          COALESCE($12::timestamptz, NOW()),
          'supabase',$1
        )
        ON CONFLICT (legacy_source, legacy_id) DO UPDATE SET
          content = EXCLUDED.content,
          is_completed = EXCLUDED.is_completed,
          completed_at = EXCLUDED.completed_at,
          completed_by = EXCLUDED.completed_by,
          position = EXCLUDED.position,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.checklist_id,
        row.task_id,
        row.organization_id,
        createdBy,
        isCompleted ? completedBy : null,
        row.content,
        isCompleted,
        isCompleted ? row.completed_at : null,
        Math.max(0, integerValue(row.position)),
        row.created_at,
        row.updated_at,
      ],
    );
    imported += 1;
  }

  return { imported, skipped };
}

async function main() {
  log(`Source: ${DEFAULT_SOURCE}`);
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  if (!fs.existsSync(DEFAULT_SOURCE)) {
    fail(`Legacy export does not exist: ${DEFAULT_SOURCE}`);
  }

  const sql = fs.readFileSync(DEFAULT_SOURCE, 'utf8');
  const checklists = extractCopyRows(sql, 'task_checklists');
  const items = extractCopyRows(sql, 'task_checklist_items');

  console.log('\n========================================');
  console.log('CHECKLIST MIGRATION');
  console.log('========================================');
  console.log(`Checklists: ${checklists.length}`);
  console.log(`Items:      ${items.length}`);
  console.log('========================================\n');

  if (!apply) {
    log('Dry run complete. No target data was written.');
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await loadExisting(client);
    const { imported, skipped } = await insertChecklists(client, checklists, existing);
    log(`Checklists imported: ${imported.size} (skipped ${skipped})`);
    const itemResult = await insertItems(client, items, imported, existing);
    log(`Items imported: ${itemResult.imported} (skipped ${itemResult.skipped})`);
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
