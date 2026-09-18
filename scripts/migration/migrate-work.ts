import { createHash } from 'node:crypto';
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
  console.log(`[work-migration] ${message}`);
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

function jsonOrDefault(
  value: string | null,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return fallback;
  } catch {
    return fallback;
  }
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

function stableUuid(seed: string) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function loadExistingIds(client: PoolClient) {
  const [orgs, users] = await Promise.all([
    client.query<{ id: string }>('SELECT id FROM organizations.organizations'),
    client.query<{ id: string }>('SELECT id FROM identity.users'),
  ]);

  return {
    organizations: new Set(orgs.rows.map((row) => row.id)),
    users: new Set(users.rows.map((row) => row.id)),
  };
}

async function fallbackCreator(
  client: PoolClient,
  organizationId: string,
  users: Set<string>,
) {
  const result = await client.query<{ user_id: string }>(
    `
      SELECT membership.user_id
      FROM organizations.memberships membership
      JOIN organizations.roles role
        ON role.id = membership.role_id
      WHERE membership.organization_id = $1
        AND membership.status = 'active'
        AND role.is_admin_role = TRUE
      ORDER BY membership.created_at ASC
      LIMIT 1
    `,
    [organizationId],
  );

  const admin = result.rows[0]?.user_id;
  if (admin && users.has(admin)) return admin;

  const anyUser = [...users][0];
  if (!anyUser) {
    throw new Error(`No identity user available to own work in ${organizationId}`);
  }
  return anyUser;
}

async function insertBoards(
  client: PoolClient,
  clients: LegacyRow[],
  columns: LegacyRow[],
  existing: { organizations: Set<string>; users: Set<string> },
) {
  const boardIds = new Set<string>();

  for (const row of clients) {
    if (!row.id || !row.organization_id) continue;
    if (!existing.organizations.has(row.organization_id)) continue;

    const createdBy =
      row.created_by && existing.users.has(row.created_by)
        ? row.created_by
        : await fallbackCreator(client, row.organization_id, existing.users);

    await client.query(
      `
        INSERT INTO work.boards (
          id, organization_id, created_by, owner_id, name, slug, description,
          status, position, metadata, created_at, updated_at,
          legacy_client_id, legacy_source, legacy_id
        )
        VALUES (
          $1,$2,$3,$3,$4,$5,$6,'active',0,$7::jsonb,
          COALESCE($8::timestamptz, NOW()),
          COALESCE($9::timestamptz, NOW()),
          $1,'supabase',$1
        )
        ON CONFLICT (legacy_source, legacy_id) DO UPDATE SET
          name = EXCLUDED.name,
          slug = EXCLUDED.slug,
          description = EXCLUDED.description,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.organization_id,
        createdBy,
        row.name ?? 'Board',
        row.slug,
        row.description ?? row.notes,
        JSON.stringify({
          officeId: row.office_id,
          boardType: row.board_type ?? 'client',
          industry: row.industry,
          email: row.email,
          website: row.website,
        }),
        row.created_at,
        row.updated_at,
      ],
    );
    boardIds.add(row.id);
  }

  const orgsWithNullClient = new Set(
    columns
      .filter((row) => !row.client_id && row.organization_id)
      .map((row) => row.organization_id as string),
  );

  for (const organizationId of orgsWithNullClient) {
    if (!existing.organizations.has(organizationId)) continue;
    const boardId = stableUuid(`work.boards.internal:${organizationId}`);
    const createdBy = await fallbackCreator(client, organizationId, existing.users);

    await client.query(
      `
        INSERT INTO work.boards (
          id, organization_id, created_by, name, slug, status, position,
          metadata, legacy_source, legacy_id
        )
        VALUES ($1,$2,$3,'Internal','internal','active',999,$4::jsonb,'supabase',$1)
        ON CONFLICT (legacy_source, legacy_id) DO NOTHING
      `,
      [
        boardId,
        organizationId,
        createdBy,
        JSON.stringify({ boardType: 'internal' }),
      ],
    );
    boardIds.add(boardId);
  }

  return boardIds;
}

async function insertColumns(
  client: PoolClient,
  columns: LegacyRow[],
  boardIds: Set<string>,
  existing: { organizations: Set<string> },
) {
  const columnIds = new Set<string>();

  for (const row of columns) {
    if (!row.id || !row.organization_id) continue;
    if (!existing.organizations.has(row.organization_id)) continue;

    const boardId =
      row.client_id && boardIds.has(row.client_id)
        ? row.client_id
        : stableUuid(`work.boards.internal:${row.organization_id}`);

    if (!boardIds.has(boardId)) continue;

    await client.query(
      `
        INSERT INTO work.board_columns (
          id, organization_id, board_id, legacy_client_id, name, color,
          status_key, position, created_at, updated_at, legacy_source, legacy_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          COALESCE($9::timestamptz, NOW()),
          COALESCE($10::timestamptz, NOW()),
          'supabase',$1
        )
        ON CONFLICT (legacy_source, legacy_id) DO UPDATE SET
          name = EXCLUDED.name,
          color = EXCLUDED.color,
          status_key = EXCLUDED.status_key,
          position = EXCLUDED.position,
          board_id = EXCLUDED.board_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.organization_id,
        boardId,
        row.client_id,
        row.name ?? 'Column',
        row.color,
        row.status_key,
        integerValue(row.position),
        row.created_at,
        row.updated_at,
      ],
    );
    columnIds.add(row.id);
  }

  return columnIds;
}

async function insertCards(
  client: PoolClient,
  tasks: LegacyRow[],
  boardIds: Set<string>,
  columnIds: Set<string>,
  existing: { organizations: Set<string>; users: Set<string> },
) {
  const cardIds = new Set<string>();
  let skipped = 0;

  for (const row of tasks) {
    if (!row.id || !row.organization_id || !row.title) {
      skipped += 1;
      continue;
    }
    if (!existing.organizations.has(row.organization_id)) {
      skipped += 1;
      continue;
    }

    const boardId =
      row.client_id && boardIds.has(row.client_id)
        ? row.client_id
        : stableUuid(`work.boards.internal:${row.organization_id}`);

    if (!boardIds.has(boardId)) {
      skipped += 1;
      continue;
    }

    const columnId =
      row.column_id && columnIds.has(row.column_id) ? row.column_id : null;
    const createdBy =
      row.created_by && existing.users.has(row.created_by) ? row.created_by : null;
    const assignedTo =
      row.assigned_to && existing.users.has(row.assigned_to)
        ? row.assigned_to
        : null;
    const assignedBy =
      row.assigned_by && existing.users.has(row.assigned_by)
        ? row.assigned_by
        : null;
    const archivedBy =
      row.archived_by && existing.users.has(row.archived_by)
        ? row.archived_by
        : null;

    await client.query(
      `
        INSERT INTO work.cards (
          id, organization_id, board_id, parent_card_id, column_id,
          assigned_to, assigned_by, created_by, archived_by,
          legacy_client_id, legacy_campaign_id, legacy_office_id, legacy_ticket_id,
          title, description, status_key, priority, department,
          due_at, start_at, completed_at, blocked_reason, ai_generated,
          position, metadata, tracked_seconds_cache, is_billable, estimated_seconds,
          archived_at, imported_time_status, created_at, updated_at,
          legacy_source, legacy_id
        )
        VALUES (
          $1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          $18::timestamptz,$19::timestamptz,$20::timestamptz,$21,$22,$23,$24::jsonb,
          $25,$26,$27,$28::timestamptz,$29,
          COALESCE($30::timestamptz, NOW()),
          COALESCE($31::timestamptz, NOW()),
          'supabase',$1
        )
        ON CONFLICT (legacy_source, legacy_id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          status_key = EXCLUDED.status_key,
          priority = EXCLUDED.priority,
          column_id = EXCLUDED.column_id,
          board_id = EXCLUDED.board_id,
          assigned_to = EXCLUDED.assigned_to,
          metadata = EXCLUDED.metadata,
          tracked_seconds_cache = EXCLUDED.tracked_seconds_cache,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.organization_id,
        boardId,
        columnId,
        assignedTo,
        assignedBy,
        createdBy,
        archivedBy,
        row.client_id,
        row.campaign_id,
        row.office_id,
        row.ticket_id,
        row.title,
        row.description,
        row.status ?? 'todo',
        row.priority ?? 'medium',
        row.department,
        row.due_date,
        row.start_date,
        row.completed_at,
        row.blocked_reason,
        booleanValue(row.ai_generated),
        integerValue(row.position),
        JSON.stringify(jsonOrDefault(row.metadata)),
        integerValue(row.tracked_seconds_cache),
        booleanValue(row.is_billable),
        integerValue(row.estimated_seconds),
        row.archived_at,
        row.imported_time_status,
        row.created_at,
        row.updated_at,
      ],
    );
    cardIds.add(row.id);
  }

  return { cardIds, skipped };
}

async function insertAssignees(
  client: PoolClient,
  rows: LegacyRow[],
  cardIds: Set<string>,
  existing: { organizations: Set<string>; users: Set<string> },
) {
  let imported = 0;

  for (const row of rows) {
    if (!row.id || !row.task_id || !row.user_id || !row.organization_id) continue;
    if (!cardIds.has(row.task_id)) continue;
    if (!existing.organizations.has(row.organization_id)) continue;
    if (!existing.users.has(row.user_id)) continue;

    await client.query(
      `
        INSERT INTO work.card_assignees (
          id, card_id, user_id, organization_id, created_at, legacy_source, legacy_id
        )
        VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, NOW()),'supabase',$1)
        ON CONFLICT (legacy_source, legacy_id) DO NOTHING
      `,
      [row.id, row.task_id, row.user_id, row.organization_id, row.created_at],
    );
    imported += 1;
  }

  return imported;
}

async function insertComments(
  client: PoolClient,
  rows: LegacyRow[],
  cardIds: Set<string>,
  existing: { organizations: Set<string>; users: Set<string> },
) {
  let imported = 0;

  for (const row of rows) {
    if (!row.id || !row.task_id || !row.organization_id || !row.comment) continue;
    if (!cardIds.has(row.task_id)) continue;
    if (!existing.organizations.has(row.organization_id)) continue;
    const userId =
      row.user_id && existing.users.has(row.user_id) ? row.user_id : null;

    await client.query(
      `
        INSERT INTO work.card_comments (
          id, card_id, organization_id, user_id, body, is_internal, comment_type,
          created_at, updated_at, legacy_source, legacy_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          COALESCE($8::timestamptz, NOW()),
          COALESCE($9::timestamptz, NOW()),
          'supabase',$1
        )
        ON CONFLICT (legacy_source, legacy_id) DO UPDATE SET
          body = EXCLUDED.body,
          comment_type = EXCLUDED.comment_type,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.task_id,
        row.organization_id,
        userId,
        row.comment,
        booleanValue(row.is_internal),
        row.comment_type ?? 'comment',
        row.created_at,
        row.updated_at,
      ],
    );
    imported += 1;
  }

  return imported;
}

async function insertWatchers(
  client: PoolClient,
  rows: LegacyRow[],
  cardIds: Set<string>,
  existing: { organizations: Set<string>; users: Set<string> },
) {
  let imported = 0;

  for (const row of rows) {
    if (!row.id || !row.task_id || !row.user_id || !row.organization_id) continue;
    if (!cardIds.has(row.task_id)) continue;
    if (!existing.organizations.has(row.organization_id)) continue;
    if (!existing.users.has(row.user_id)) continue;

    await client.query(
      `
        INSERT INTO work.card_watchers (
          id, card_id, user_id, organization_id, created_at, legacy_source, legacy_id
        )
        VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, NOW()),'supabase',$1)
        ON CONFLICT (legacy_source, legacy_id) DO NOTHING
      `,
      [row.id, row.task_id, row.user_id, row.organization_id, row.created_at],
    );
    imported += 1;
  }

  return imported;
}

async function main() {
  log(`Source: ${DEFAULT_SOURCE}`);
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  if (!fs.existsSync(DEFAULT_SOURCE)) {
    fail(`Legacy export does not exist: ${DEFAULT_SOURCE}`);
  }

  const sql = fs.readFileSync(DEFAULT_SOURCE, 'utf8');
  log('Extracting legacy COPY blocks...');

  const clients = extractCopyRows(sql, 'clients');
  const columns = extractCopyRows(sql, 'task_board_columns');
  const tasks = extractCopyRows(sql, 'tasks');
  const assignees = extractCopyRows(sql, 'task_assignees');
  const comments = extractCopyRows(sql, 'task_comments');
  const watchers = extractCopyRows(sql, 'task_watchers');

  console.log('\n========================================');
  console.log('WORK MIGRATION');
  console.log('========================================');
  console.log(`Clients / boards:    ${clients.length}`);
  console.log(`Board columns:       ${columns.length}`);
  console.log(`Tasks / cards:       ${tasks.length}`);
  console.log(`Assignees:           ${assignees.length}`);
  console.log(`Comments:            ${comments.length}`);
  console.log(`Watchers:            ${watchers.length}`);
  console.log('========================================\n');

  if (!apply) {
    log('Dry run complete. No target data was written.');
    return;
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const existing = await loadExistingIds(client);
    const boardIds = await insertBoards(client, clients, columns, existing);
    log(`Boards imported: ${boardIds.size}`);
    const columnIds = await insertColumns(client, columns, boardIds, existing);
    log(`Columns imported: ${columnIds.size}`);
    const { cardIds, skipped } = await insertCards(
      client,
      tasks,
      boardIds,
      columnIds,
      existing,
    );
    log(`Cards imported: ${cardIds.size} (skipped ${skipped})`);
    const assigneeCount = await insertAssignees(
      client,
      assignees,
      cardIds,
      existing,
    );
    log(`Assignees imported: ${assigneeCount}`);
    const commentCount = await insertComments(
      client,
      comments,
      cardIds,
      existing,
    );
    log(`Comments imported: ${commentCount}`);
    const watcherCount = await insertWatchers(
      client,
      watchers,
      cardIds,
      existing,
    );
    log(`Watchers imported: ${watcherCount}`);
    await client.query('COMMIT');
    log('Work migration completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error('\nWork migration failed:', error);
  process.exit(1);
});
