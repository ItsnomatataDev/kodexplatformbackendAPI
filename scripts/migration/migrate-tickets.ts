import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { env } from '../../src/config/env.js';
import { db } from '../../src/db/pool.js';
import { MinioFileStorage } from '../../src/files/minio-storage.js';
import { ticketAttachmentObjectKey } from '../../src/tickets/store.js';

type LegacyRow = Record<string, string | null>;

const DEFAULT_SOURCE = path.resolve(
  process.env.LEGACY_EXPORT ??
    `${process.env.HOME}/Desktop/devprojects/POSTGRES-SERVER/backups/public-data-20260826T104827Z.sql`,
);

const TICKET_STATUSES = new Set([
  'open',
  'assigned',
  'in_progress',
  'waiting_for_requester',
  'waiting_for_third_party',
  'resolved',
  'closed',
  'reopened',
]);
const TICKET_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const REQUESTER_TYPES = new Set(['internal', 'external']);
const COMMENT_VISIBILITY = new Set(['public', 'internal']);
const AUTHOR_TYPES = new Set(['internal', 'external']);

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function log(message: string) {
  console.log(`[ticket-migration] ${message}`);
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

function safeFilename(value: string) {
  const trimmed = value.trim() || 'attachment';
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const cleaned = base.replace(/[\u0000-\u001f]/g, '_').slice(0, 255);
  return cleaned || 'attachment';
}

function storageUrl() {
  return (
    process.env.LEGACY_STORAGE_URL ??
    'https://zirftywinscopzuuwdlg.supabase.co'
  ).replace(/\/+$/, '');
}

function storageKey() {
  return (
    process.env.LEGACY_STORAGE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    ''
  ).trim();
}

function optionalExisting(id: string | null | undefined, known: Set<string>) {
  return id && known.has(id) ? id : null;
}

async function fallbackUploader(client: PoolClient, organizationId: string) {
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
  return result.rows[0]?.user_id ?? null;
}

async function loadExisting(client: PoolClient) {
  const orgs = await client.query<{ id: string }>(
    'SELECT id FROM organizations.organizations',
  );
  const users = await client.query<{ id: string }>('SELECT id FROM identity.users');
  const offices = await client.query<{ id: string }>(
    'SELECT id FROM organizations.offices',
  );
  const cards = await client.query<{
    id: string;
    organization_id: string;
    legacy_ticket_id: string | null;
  }>('SELECT id, organization_id, legacy_ticket_id FROM work.cards');
  const tickets = await client.query<{ id: string; ticket_number: string }>(
    'SELECT id, ticket_number FROM tickets.tickets',
  );
  const comments = await client.query<{ id: string }>(
    'SELECT id FROM tickets.ticket_comments',
  );
  const attachments = await client.query<{ id: string }>(
    'SELECT id FROM tickets.ticket_attachments',
  );

  return {
    organizations: new Set(orgs.rows.map((row) => row.id)),
    users: new Set(users.rows.map((row) => row.id)),
    offices: new Set(offices.rows.map((row) => row.id)),
    cards: new Set(cards.rows.map((row) => row.id)),
    tickets: new Set(tickets.rows.map((row) => row.id)),
    ticketNumbers: new Set(tickets.rows.map((row) => row.ticket_number)),
    comments: new Set(comments.rows.map((row) => row.id)),
    attachments: new Set(attachments.rows.map((row) => row.id)),
  };
}

async function importTickets(
  client: PoolClient,
  rows: LegacyRow[],
  existing: Awaited<ReturnType<typeof loadExisting>>,
) {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (
      !row.id ||
      !row.organization_id ||
      !row.ticket_number ||
      !row.category ||
      !row.subject ||
      !row.description
    ) {
      skipped += 1;
      continue;
    }
    if (!existing.organizations.has(row.organization_id)) {
      skipped += 1;
      continue;
    }
    if (existing.tickets.has(row.id) || existing.ticketNumbers.has(row.ticket_number)) {
      skipped += 1;
      continue;
    }

    const requesterType = REQUESTER_TYPES.has(row.requester_type ?? '')
      ? row.requester_type
      : 'internal';
    const status = TICKET_STATUSES.has(row.status ?? '') ? row.status : 'open';
    const priority = TICKET_PRIORITIES.has(row.priority ?? '') ? row.priority : 'medium';
    const linkedCardId = optionalExisting(row.linked_task_id, existing.cards);

    try {
      await client.query(
        `
          INSERT INTO tickets.tickets (
            id, organization_id, office_id, linked_card_id, ticket_number,
            requester_type, user_id, created_by, assigned_to, requester_email,
            category, subject, description, status, priority, resolved_at,
            closed_at, closed_by, created_at, updated_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16::timestamptz,$17::timestamptz,$18,
            COALESCE($19::timestamptz, NOW()),
            COALESCE($20::timestamptz, NOW())
          )
          ON CONFLICT (id) DO NOTHING
        `,
        [
          row.id,
          row.organization_id,
          optionalExisting(row.office_id, existing.offices),
          linkedCardId,
          row.ticket_number,
          requesterType,
          optionalExisting(row.user_id, existing.users),
          optionalExisting(row.created_by, existing.users),
          optionalExisting(row.assigned_to, existing.users),
          row.requester_email,
          row.category,
          row.subject,
          row.description,
          status,
          priority,
          row.resolved_at,
          row.closed_at,
          optionalExisting(row.closed_by, existing.users),
          row.created_at,
          row.updated_at,
        ],
      );
      existing.tickets.add(row.id);
      existing.ticketNumbers.add(row.ticket_number);
      imported += 1;
    } catch (error) {
      skipped += 1;
      log(
        `Skipped ticket ${row.ticket_number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await client.query(`
    UPDATE tickets.tickets ticket
    SET linked_card_id = card.id
    FROM work.cards card
    WHERE card.organization_id = ticket.organization_id
      AND card.legacy_ticket_id = ticket.id
      AND ticket.linked_card_id IS NULL
  `);

  return { imported, skipped };
}

async function importComments(
  client: PoolClient,
  rows: LegacyRow[],
  existing: Awaited<ReturnType<typeof loadExisting>>,
) {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.id || !row.ticket_id || !row.organization_id || !row.body?.trim()) {
      skipped += 1;
      continue;
    }
    if (
      !existing.tickets.has(row.ticket_id) ||
      !existing.organizations.has(row.organization_id)
    ) {
      skipped += 1;
      continue;
    }
    if (existing.comments.has(row.id)) {
      skipped += 1;
      continue;
    }

    const authorType = AUTHOR_TYPES.has(row.author_type ?? '')
      ? row.author_type
      : 'internal';
    const visibility = COMMENT_VISIBILITY.has(row.visibility ?? '')
      ? row.visibility
      : 'public';

    await client.query(
      `
        INSERT INTO tickets.ticket_comments (
          id, ticket_id, organization_id, author_id, author_type, body,
          visibility, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, NOW()))
        ON CONFLICT (id) DO NOTHING
      `,
      [
        row.id,
        row.ticket_id,
        row.organization_id,
        optionalExisting(row.author_id, existing.users),
        authorType,
        row.body,
        visibility,
        row.created_at,
      ],
    );
    existing.comments.add(row.id);
    imported += 1;
  }

  return { imported, skipped };
}

async function downloadStorageObject(objectPath: string) {
  const key = storageKey();
  if (!key) {
    fail(
      'Set LEGACY_STORAGE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY) to copy file bytes.',
    );
  }

  const response = await fetch(
    `${storageUrl()}/storage/v1/object/service-desk-attachments/${encodeURI(objectPath)}`,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Storage download failed (${response.status}) for ${objectPath}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function importAttachments(
  client: PoolClient,
  rows: LegacyRow[],
  existing: Awaited<ReturnType<typeof loadExisting>>,
  files: MinioFileStorage,
) {
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (
      !row.id ||
      !row.ticket_id ||
      !row.organization_id ||
      !row.file_path ||
      !row.file_name
    ) {
      skipped += 1;
      continue;
    }
    if (
      !existing.tickets.has(row.ticket_id) ||
      !existing.organizations.has(row.organization_id)
    ) {
      skipped += 1;
      continue;
    }
    if (existing.attachments.has(row.id)) {
      skipped += 1;
      continue;
    }

    const filename = safeFilename(row.file_name);
    const objectKey = ticketAttachmentObjectKey(
      row.organization_id,
      row.ticket_id,
      row.id,
      filename,
    );
    const uploadedBy =
      optionalExisting(row.uploaded_by, existing.users) ??
      (await fallbackUploader(client, row.organization_id));

    try {
      const body = await downloadStorageObject(row.file_path);
      await files.putObject({
        bucket: env.minio.bucket,
        objectKey,
        body,
        contentType: row.mime_type ?? 'application/octet-stream',
      });
      await client.query(
        `
          INSERT INTO tickets.ticket_attachments (
            id, ticket_id, organization_id, uploaded_by, bucket, object_key,
            original_filename, content_type, size_bytes, checksum, created_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, NOW()))
          ON CONFLICT (id) DO NOTHING
        `,
        [
          row.id,
          row.ticket_id,
          row.organization_id,
          uploadedBy,
          env.minio.bucket,
          objectKey,
          filename,
          row.mime_type,
          body.byteLength,
          createHash('sha256').update(body).digest('hex'),
          row.created_at,
        ],
      );
      existing.attachments.add(row.id);
      imported += 1;
      log(`Stored ${filename} (${body.byteLength} bytes)`);
    } catch (error) {
      failed += 1;
      await files.deleteObject(env.minio.bucket, objectKey).catch(() => undefined);
      log(
        `Failed ${row.file_path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { imported, skipped, failed };
}

async function main() {
  log(`Source: ${DEFAULT_SOURCE}`);
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  log(`MinIO bucket: ${env.minio.bucket}`);
  log(`Legacy storage: ${storageUrl()}`);

  if (!fs.existsSync(DEFAULT_SOURCE)) {
    fail(`Legacy export does not exist: ${DEFAULT_SOURCE}`);
  }

  const sql = fs.readFileSync(DEFAULT_SOURCE, 'utf8');
  log('Extracting legacy COPY blocks...');
  const tickets = extractCopyRows(sql, 'tickets');
  const comments = extractCopyRows(sql, 'ticket_comments');
  const attachments = extractCopyRows(sql, 'ticket_attachments');

  console.log('\n========================================');
  console.log('TICKET MIGRATION');
  console.log('========================================');
  console.log(`Legacy tickets: ${tickets.length}`);
  console.log(`Legacy comments: ${comments.length}`);
  console.log(`Legacy attachments: ${attachments.length}`);
  console.log(`MinIO prefix: {orgId}/tickets/{ticketId}/attachments/...`);
  console.log('========================================\n');

  if (!apply) {
    log('Dry run complete. No tickets or files were written.');
    return;
  }

  if (!env.minio.accessKey || !env.minio.secretKey) {
    fail('MinIO credentials are not configured.');
  }

  const files = new MinioFileStorage();
  const client = await db.connect();

  try {
    const existing = await loadExisting(client);
    const ticketResult = await importTickets(client, tickets, existing);
    log(
      `Tickets imported: ${ticketResult.imported} (skipped ${ticketResult.skipped})`,
    );
    const commentResult = await importComments(client, comments, existing);
    log(
      `Comments imported: ${commentResult.imported} (skipped ${commentResult.skipped})`,
    );
    const fileResult = await importAttachments(
      client,
      attachments,
      existing,
      files,
    );
    log(
      `Attachments imported: ${fileResult.imported} (skipped ${fileResult.skipped}, failed ${fileResult.failed})`,
    );
    if (fileResult.failed > 0) {
      fail(`${fileResult.failed} ticket attachment(s) could not be stored in MinIO.`);
    }
    log('Ticket migration completed successfully.');
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
