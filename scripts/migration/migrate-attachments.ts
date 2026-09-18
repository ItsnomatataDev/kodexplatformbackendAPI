import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { env } from '../../src/config/env.js';
import { db } from '../../src/db/pool.js';
import { MinioFileStorage } from '../../src/files/minio-storage.js';

type LegacyRow = Record<string, string | null>;

const DEFAULT_SOURCE = path.resolve(
  process.env.LEGACY_EXPORT ??
    `${process.env.HOME}/Desktop/devprojects/POSTGRES-SERVER/backups/public-data-20260826T104827Z.sql`,
);

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function log(message: string) {
  console.log(`[attachment-migration] ${message}`);
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

  const admin = result.rows[0]?.user_id;
  if (admin) return admin;
  throw new Error(`No identity user available to own attachments in ${organizationId}`);
}

async function loadExisting(client: PoolClient) {
  const cards = await client.query<{ id: string; organization_id: string }>(
    'SELECT id, organization_id FROM work.cards',
  );
  const users = await client.query<{ id: string }>('SELECT id FROM identity.users');
  const attachments = await client.query<{ id: string }>(
    'SELECT id FROM work.card_attachments',
  );
  const submissions = await client.query<{ legacy_id: string }>(
    `SELECT legacy_id FROM work.card_submissions WHERE legacy_source = 'supabase'`,
  );

  return {
    cards: new Map(cards.rows.map((row) => [row.id, row.organization_id])),
    users: new Set(users.rows.map((row) => row.id)),
    attachments: new Set(attachments.rows.map((row) => row.id)),
    submissions: new Set(submissions.rows.map((row) => row.legacy_id)),
  };
}

async function downloadStorageObject(objectPath: string) {
  const key = storageKey();
  if (!key) {
    fail(
      'Set LEGACY_STORAGE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY) to copy file bytes.',
    );
  }

  const response = await fetch(
    `${storageUrl()}/storage/v1/object/task-submissions/${encodeURI(objectPath)}`,
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

async function importFiles(
  client: PoolClient,
  rows: LegacyRow[],
  existing: Awaited<ReturnType<typeof loadExisting>>,
  files: MinioFileStorage,
) {
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.id || !row.task_id || !row.organization_id || !row.storage_path) {
      skipped += 1;
      continue;
    }

    const organizationId = existing.cards.get(row.task_id);
    if (!organizationId || organizationId !== row.organization_id) {
      skipped += 1;
      continue;
    }

    if (existing.attachments.has(row.id)) {
      skipped += 1;
      continue;
    }

    const uploadedBy =
      row.uploaded_by && existing.users.has(row.uploaded_by)
        ? row.uploaded_by
        : await fallbackUploader(client, organizationId);
    const filename = safeFilename(row.file_name ?? path.basename(row.storage_path));
    const objectKey = `${organizationId}/cards/${row.task_id}/attachments/${row.id}/${filename}`;

    try {
      const body = await downloadStorageObject(row.storage_path);
      await files.putObject({
        bucket: env.minio.bucket,
        objectKey,
        body,
        contentType: row.mime_type ?? 'application/octet-stream',
      });

      await client.query(
        `
          INSERT INTO work.card_attachments (
            id, card_id, organization_id, uploaded_by, bucket, object_key,
            original_filename, content_type, size_bytes, checksum, created_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, NOW()))
          ON CONFLICT (id) DO NOTHING
        `,
        [
          row.id,
          row.task_id,
          organizationId,
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
      imported += 1;
      log(`Stored ${filename} (${body.byteLength} bytes)`);
    } catch (error) {
      failed += 1;
      await files.deleteObject(env.minio.bucket, objectKey).catch(() => undefined);
      log(
        `Failed ${row.storage_path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { imported, skipped, failed };
}

async function importLinks(
  client: PoolClient,
  rows: LegacyRow[],
  existing: Awaited<ReturnType<typeof loadExisting>>,
) {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.id || !row.task_id || !row.organization_id || !row.file_url) {
      skipped += 1;
      continue;
    }

    const organizationId = existing.cards.get(row.task_id);
    if (!organizationId || organizationId !== row.organization_id) {
      skipped += 1;
      continue;
    }

    if (existing.submissions.has(row.id)) {
      skipped += 1;
      continue;
    }

    const submittedBy =
      row.uploaded_by && existing.users.has(row.uploaded_by)
        ? row.uploaded_by
        : await fallbackUploader(client, organizationId);

    await client.query(
      `
        INSERT INTO work.card_submissions (
          id, card_id, organization_id, submitted_by, submission_type, title,
          notes, link_url, file_name, mime_type, file_size, approval_status,
          created_at, updated_at, legacy_source, legacy_id
        )
        VALUES (
          $1,$2,$3,$4,'link',$5,NULL,$6,$5,$7,$8,'approved',
          COALESCE($9::timestamptz, NOW()), COALESCE($9::timestamptz, NOW()),
          'supabase',$1
        )
        ON CONFLICT (legacy_source, legacy_id) DO NOTHING
      `,
      [
        row.id,
        row.task_id,
        organizationId,
        submittedBy,
        (row.file_name ?? row.file_url).slice(0, 200),
        row.file_url,
        row.mime_type,
        row.file_size ? Number(row.file_size) : null,
        row.created_at,
      ],
    );
    imported += 1;
  }

  return { imported, skipped };
}

async function main() {
  log(`Source: ${DEFAULT_SOURCE}`);
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  log(`MinIO bucket: ${env.minio.bucket}`);
  log(`Legacy storage: ${storageUrl()}`);

  if (!fs.existsSync(DEFAULT_SOURCE)) {
    fail(`Legacy export does not exist: ${DEFAULT_SOURCE}`);
  }

  if (!env.minio.accessKey || !env.minio.secretKey) {
    fail('MinIO credentials are not configured.');
  }

  const sql = fs.readFileSync(DEFAULT_SOURCE, 'utf8');
  log('Extracting legacy COPY blocks...');
  const attachments = extractCopyRows(sql, 'task_attachments');
  const files = attachments.filter((row) => Boolean(row.storage_path));
  const links = attachments.filter((row) => !row.storage_path && Boolean(row.file_url));

  console.log('\n========================================');
  console.log('ATTACHMENT MIGRATION');
  console.log('========================================');
  console.log(`Legacy attachments: ${attachments.length}`);
  console.log(`Files (Supabase storage → MinIO): ${files.length}`);
  console.log(`Links (kept as submissions, not objects): ${links.length}`);
  console.log('========================================\n');

  if (!apply) {
    log('Dry run complete. No files or rows were written.');
    log('Trello download URLs are not imported as objects; they stay as link submissions.');
    return;
  }

  const filesStorage = new MinioFileStorage();
  const client = await db.connect();

  try {
    const existing = await loadExisting(client);
    const fileResult = await importFiles(client, files, existing, filesStorage);
    log(
      `Files imported: ${fileResult.imported} (skipped ${fileResult.skipped}, failed ${fileResult.failed})`,
    );
    const linkResult = await importLinks(client, links, existing);
    log(`Link submissions imported: ${linkResult.imported} (skipped ${linkResult.skipped})`);
    if (fileResult.failed > 0) {
      fail(`${fileResult.failed} file attachment(s) could not be stored in MinIO.`);
    }
    log('Attachment migration completed successfully.');
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
