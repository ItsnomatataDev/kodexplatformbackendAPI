/**
 * Copy Content Studio media bytes from legacy Supabase Storage into MinIO,
 * then rewrite file_url to the Kode media proxy.
 *
 * Covers content.schedule_assets and content.client_media.
 *
 * Put the service role key in kode-platform `.env` (gitignored):
 *   LEGACY_STORAGE_URL=https://…supabase.co
 *   LEGACY_STORAGE_SERVICE_ROLE_KEY=…
 *
 * Then run:
 *   npm run migrate:content-studio-media
 *   npm run migrate:content-studio-media -- --apply
 *   npm run migrate:content-studio-media -- --apply --allow-missing
 *
 * `--allow-missing` exits 0 when Supabase returns 400/404 for deleted objects.
 */
import { db } from '../../src/db/pool.js';
import { env } from '../../src/config/env.js';
import { CONTENT_REVIEW_ASSETS_BUCKET } from '../../src/content/buckets.js';
import { MinioFileStorage } from '../../src/files/minio-storage.js';

type MediaRow = {
  id: string;
  table: 'schedule_assets' | 'client_media';
  storage_path: string;
  file_url: string;
  mime_type: string | null;
  file_name: string | null;
};

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const allowMissing = args.has('--allow-missing');

function log(message: string) {
  console.log(`[content-studio-media] ${message}`);
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function storageUrl() {
  return (
    process.env.LEGACY_STORAGE_URL ??
    'https://zirftywinscopzuuwdlg.supabase.co'
  ).replace(/\/+$/, '');
}

function storageKey() {
  // Prefer non-empty values — an empty shell export must not block `.env`.
  const candidates = [
    process.env.LEGACY_STORAGE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? '';
    if (trimmed) return trimmed;
  }
  return '';
}

function isMissingObjectError(message: string) {
  return /Storage download failed \((400|404)\)/.test(message);
}

function mediaProxyUrl(objectKey: string) {
  return `/api/content-studio/media?objectKey=${encodeURIComponent(objectKey)}`;
}

function needsMigration(fileUrl: string) {
  // Always process rows with a storage_path. migrateRow skips the upload when
  // MinIO already has the object, and still rewrites legacy Supabase URLs.
  // Proxy URLs alone must not skip — an earlier cutover rewrote file_url without
  // copying bytes, which left review/edit media 404ing.
  void fileUrl;
  return true;
}

async function loadRows(): Promise<MediaRow[]> {
  const assets = await db.query<{
    id: string;
    storage_path: string | null;
    file_url: string;
    mime_type: string | null;
    file_name: string | null;
  }>(
    `
      SELECT id, storage_path, file_url, mime_type, file_name
      FROM content.schedule_assets
      WHERE storage_path IS NOT NULL
        AND btrim(storage_path) <> ''
      ORDER BY created_at ASC
    `,
  );

  const media = await db.query<{
    id: string;
    storage_path: string | null;
    file_url: string;
    mime_type: string | null;
    file_name: string | null;
  }>(
    `
      SELECT id, storage_path, file_url, mime_type, file_name
      FROM content.client_media
      WHERE storage_path IS NOT NULL
        AND btrim(storage_path) <> ''
      ORDER BY created_at ASC
    `,
  );

  return [
    ...assets.rows
      .filter((row) => row.storage_path && needsMigration(row.file_url))
      .map((row) => ({
        id: row.id,
        table: 'schedule_assets' as const,
        storage_path: row.storage_path!,
        file_url: row.file_url,
        mime_type: row.mime_type,
        file_name: row.file_name,
      })),
    ...media.rows
      .filter((row) => row.storage_path && needsMigration(row.file_url))
      .map((row) => ({
        id: row.id,
        table: 'client_media' as const,
        storage_path: row.storage_path!,
        file_url: row.file_url,
        mime_type: row.mime_type,
        file_name: row.file_name,
      })),
  ];
}

async function downloadStorageObject(objectPath: string) {
  const key = storageKey();
  if (!key) {
    fail(
      'Set LEGACY_STORAGE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY) to copy file bytes.',
    );
  }

  const response = await fetch(
    `${storageUrl()}/storage/v1/object/${CONTENT_REVIEW_ASSETS_BUCKET}/${encodeURI(objectPath)}`,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Storage download failed (${response.status}) for ${objectPath}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function rewriteUrl(row: MediaRow, proxyUrl: string) {
  if (row.table === 'schedule_assets') {
    await db.query(
      `UPDATE content.schedule_assets SET file_url = $2 WHERE id = $1`,
      [row.id, proxyUrl],
    );
    return;
  }

  await db.query(`UPDATE content.client_media SET file_url = $2 WHERE id = $1`, [
    row.id,
    proxyUrl,
  ]);
}

async function migrateRow(
  row: MediaRow,
  files: MinioFileStorage,
  uploadedKeys: Set<string>,
) {
  const objectKey = row.storage_path;
  const proxyUrl = mediaProxyUrl(objectKey);

  if (!uploadedKeys.has(objectKey)) {
    // Prefer HEAD — getObject downloads the whole body and times out on large
    // videos when migrating over an SSH tunnel.
    const existing = files.headObject
      ? await files.headObject(CONTENT_REVIEW_ASSETS_BUCKET, objectKey)
      : await files.getObject(CONTENT_REVIEW_ASSETS_BUCKET, objectKey);
    if (!existing) {
      const body = await downloadStorageObject(objectKey);
      await files.putObject({
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        objectKey,
        body,
        contentType: row.mime_type ?? 'application/octet-stream',
      });
      log(
        `Stored ${row.table}/${row.id} → ${objectKey} (${body.byteLength} bytes)`,
      );
    } else {
      log(`MinIO already has ${objectKey}; rewriting URL only`);
    }
    uploadedKeys.add(objectKey);
  }

  await rewriteUrl(row, proxyUrl);
}

async function main() {
  const key = storageKey();
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  log(`Legacy storage: ${storageUrl()}`);
  log(`MinIO endpoint: ${env.minio.endpoint}`);
  log(`MinIO bucket: ${CONTENT_REVIEW_ASSETS_BUCKET}`);
  log(
    key
      ? `Service role key: loaded (${key.length} chars)`
      : 'Service role key: MISSING (set LEGACY_STORAGE_SERVICE_ROLE_KEY in .env)',
  );

  if (!env.minio.accessKey || !env.minio.secretKey) {
    fail('MinIO credentials are not configured.');
  }

  const rows = await loadRows();
  const scheduleCount = rows.filter((r) => r.table === 'schedule_assets').length;
  const libraryCount = rows.filter((r) => r.table === 'client_media').length;

  console.log('\n========================================');
  console.log('CONTENT STUDIO MEDIA MIGRATION');
  console.log('========================================');
  console.log(`Schedule assets needing copy: ${scheduleCount}`);
  console.log(`Client library media needing copy: ${libraryCount}`);
  console.log(`Total: ${rows.length}`);
  console.log('========================================\n');

  if (rows.length === 0) {
    log('Nothing left to migrate. Schedule + library media URLs are already on MinIO.');
    await db.end();
    return;
  }

  if (!apply) {
    log('Dry run complete. No files or rows were written.');
    log('Re-run with: npm run migrate:content-studio-media -- --apply --allow-missing');
    await db.end();
    return;
  }

  if (!key) {
    fail(
      'Set LEGACY_STORAGE_SERVICE_ROLE_KEY in kode-platform/.env (do not export an empty shell var).',
    );
  }

  const files = new MinioFileStorage();
  await files.ensureBucket?.(CONTENT_REVIEW_ASSETS_BUCKET);

  let imported = 0;
  let missing = 0;
  let failed = 0;
  const uploadedKeys = new Set<string>();

  for (const row of rows) {
    try {
      await migrateRow(row, files, uploadedKeys);
      imported += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingObjectError(message)) {
        missing += 1;
        log(`Missing in Supabase (skipped): ${row.table}/${row.id}`);
      } else {
        failed += 1;
        log(`Failed ${row.table}/${row.id} (${row.storage_path}): ${message}`);
      }
    }
  }

  log(`Migrated: ${imported} (missing ${missing}, failed ${failed})`);
  if (failed > 0) {
    fail(`${failed} Content Studio media object(s) could not be migrated.`);
  }
  if (missing > 0 && !allowMissing) {
    fail(
      `${missing} object(s) are gone from Supabase. Re-run with --allow-missing to accept that.`,
    );
  }
  if (missing > 0) {
    log(`${missing} object(s) were already deleted in Supabase; left as legacy URLs.`);
  }
  log('Content Studio media migration completed successfully.');
  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end().catch(() => undefined);
  process.exitCode = 1;
});
