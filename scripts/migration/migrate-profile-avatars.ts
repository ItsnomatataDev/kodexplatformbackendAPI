import { createHash } from 'node:crypto';
import { db } from '../../src/db/pool.js';
import { env } from '../../src/config/env.js';
import { MinioFileStorage } from '../../src/files/minio-storage.js';
import { PROFILE_PICTURES_BUCKET } from '../../src/organizations/buckets.js';
import { supabaseConfig } from './supabase-rest.js';

type AvatarRow = {
  user_id: string;
  avatar_url: string;
};

type LegacyObject = {
  bucket: string;
  objectKey: string;
};

type DownloadedAvatar = {
  body: Buffer;
  contentType: string;
};

const DEFAULT_STORAGE_URL = 'https://zirftywinscopzuuwdlg.supabase.co';
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const allowMissing = args.has('--allow-missing');

function log(message: string) {
  console.log(`[profile-avatar-migration] ${message}`);
}

function legacyStorageUrl() {
  return (
    process.env.LEGACY_STORAGE_URL ??
    process.env.SUPABASE_URL ??
    DEFAULT_STORAGE_URL
  ).replace(/\/+$/, '');
}

function parseLegacyObject(value: string): LegacyObject | null {
  let candidate: URL;
  let expected: URL;
  try {
    candidate = new URL(value);
    expected = new URL(legacyStorageUrl());
  } catch {
    return null;
  }

  if (candidate.origin !== expected.origin) return null;
  const match = candidate.pathname.match(
    /^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/,
  );
  if (!match) return null;

  try {
    const bucket = decodeURIComponent(match[1]);
    const objectKey = match[2]
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
    const segments = objectKey.split('/');
    if (
      !bucket ||
      segments.some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          segment.includes('\\'),
      )
    ) {
      return null;
    }
    return { bucket, objectKey };
  } catch {
    return null;
  }
}

function destinationObjectKey(row: AvatarRow, source: LegacyObject) {
  const digest = createHash('sha256')
    .update(`${source.bucket}/${source.objectKey}`)
    .digest('hex')
    .slice(0, 24);
  return `${row.user_id}/legacy-${digest}`;
}

function profileAvatarUrl(objectKey: string) {
  return `/api/organization/avatar/file?objectKey=${encodeURIComponent(objectKey)}`;
}

async function loadRows(): Promise<AvatarRow[]> {
  const result = await db.query<AvatarRow>(
    `
      SELECT user_id, avatar_url
      FROM identity.user_profiles
      WHERE avatar_url IS NOT NULL
        AND btrim(avatar_url) <> ''
      ORDER BY user_id
    `,
  );
  return result.rows;
}

async function readLimitedBody(response: Response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) {
    await response.body?.cancel();
    throw new Error('Avatar exceeds the 5 MiB import limit.');
  }
  if (!response.body) throw new Error('Supabase returned an empty response body.');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_AVATAR_BYTES) {
      await reader.cancel();
      throw new Error('Avatar exceeds the 5 MiB import limit.');
    }
    chunks.push(value);
  }
  if (size === 0) throw new Error('Supabase returned an empty avatar.');
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

async function downloadAvatar(
  source: LegacyObject,
  legacyUrl: string,
  serviceKey: string,
): Promise<DownloadedAvatar> {
  const encodedKey = source.objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url =
    `${legacyUrl}/storage/v1/object/` +
    `${encodeURIComponent(source.bucket)}/${encodedKey}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 404) {
    throw new Error('AVATAR_SOURCE_MISSING');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Supabase download failed (HTTP ${response.status}).`);
  }

  const rawContentType = response.headers.get('content-type') ?? '';
  const contentType = rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') {
    await response.body?.cancel();
    throw new Error('Supabase object is not a supported raster image.');
  }

  return {
    body: await readLimitedBody(response),
    contentType,
  };
}

async function migrateRow(
  row: AvatarRow,
  source: LegacyObject,
  legacyUrl: string,
  serviceKey: string,
  files: MinioFileStorage,
) {
  const objectKey = destinationObjectKey(row, source);
  const existing = files.headObject
    ? await files.headObject(PROFILE_PICTURES_BUCKET, objectKey)
    : await files.getObject(PROFILE_PICTURES_BUCKET, objectKey);

  if (!existing) {
    const downloaded = await downloadAvatar(source, legacyUrl, serviceKey);
    await files.putObject({
      bucket: PROFILE_PICTURES_BUCKET,
      objectKey,
      body: downloaded.body,
      contentType: downloaded.contentType,
    });
    log(
      `Copied avatar for user ${row.user_id} (${downloaded.body.byteLength} bytes).`,
    );
  } else {
    log(`Avatar already exists for user ${row.user_id}; updating its URL.`);
  }

  const updated = await db.query(
    `
      UPDATE identity.user_profiles
      SET avatar_url = $3, updated_at = NOW()
      WHERE user_id = $1 AND avatar_url = $2
    `,
    [row.user_id, row.avatar_url, profileAvatarUrl(objectKey)],
  );

  if (updated.rowCount === 0) {
    log(
      `Skipped URL update for user ${row.user_id}; profile changed during migration.`,
    );
    return 'stale' as const;
  }
  return 'migrated' as const;
}

async function main() {
  const unknownArgs = [...args].filter(
    (arg) => arg !== '--apply' && arg !== '--allow-missing',
  );
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument: ${unknownArgs[0]}`);
  }
  if (allowMissing && !apply) {
    throw new Error('--allow-missing can only be used with --apply.');
  }

  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  log(`Supabase source: ${new URL(legacyStorageUrl()).origin}`);
  log(`MinIO endpoint: ${env.minio.endpoint}`);
  log(`MinIO bucket: ${PROFILE_PICTURES_BUCKET}`);

  const rows = await loadRows();
  const importable = rows.flatMap((row) => {
    const source = parseLegacyObject(row.avatar_url);
    return source ? [{ row, source }] : [];
  });
  log(`Profiles with avatar URLs: ${rows.length}`);
  log(`Supabase avatar objects to migrate: ${importable.length}`);
  log(
    `Other/external or already migrated URLs left unchanged: ${rows.length - importable.length}`,
  );

  if (!apply) {
    log('Dry run complete. No files or rows were written.');
    log(
      'Review the counts, then run with --apply to import the listed Supabase objects.',
    );
    return;
  }
  if (importable.length === 0) {
    log('Nothing to migrate.');
    return;
  }
  if (!env.minio.accessKey || !env.minio.secretKey) {
    throw new Error('MinIO credentials are not configured.');
  }

  const { url: configuredLegacyUrl, key } = supabaseConfig();
  if (new URL(configuredLegacyUrl).origin !== new URL(legacyStorageUrl()).origin) {
    throw new Error('Supabase URL configuration changed while preparing migration.');
  }

  const files = new MinioFileStorage();
  await files.ensureBucket?.(PROFILE_PICTURES_BUCKET);
  let migrated = 0;
  let missing = 0;
  let stale = 0;
  let failed = 0;

  for (const { row, source } of importable) {
    try {
      const outcome = await migrateRow(
        row,
        source,
        configuredLegacyUrl,
        key,
        files,
      );
      if (outcome === 'migrated') migrated += 1;
      else stale += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'AVATAR_SOURCE_MISSING') {
        missing += 1;
        log(`Source avatar missing for user ${row.user_id}; URL left unchanged.`);
      } else {
        failed += 1;
        log(`Failed avatar migration for user ${row.user_id}: ${message}`);
      }
    }
  }

  log(
    `Updated: ${migrated}; missing: ${missing}; changed during import: ${stale}; failed: ${failed}.`,
  );
  if (failed > 0) throw new Error(`${failed} avatar object(s) could not be migrated.`);
  if (missing > 0 && !allowMissing) {
    throw new Error(
      `${missing} source avatar(s) are missing; re-run with --allow-missing to accept those gaps.`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
