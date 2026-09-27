import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../src/db/pool.js';

const BACKUPS_DIR = path.resolve(
  `${process.env.HOME}/Desktop/devprojects/POSTGRES-SERVER/backups`,
);


const CLIENTS_SOURCE = path.resolve(
  process.env.CONTENT_CLIENTS_EXPORT ??
    `${BACKUPS_DIR}/public-data-20260826T104827Z.sql`,
);
const SCHEDULES_SOURCE = path.resolve(
  process.env.CONTENT_STUDIO_EXPORT ??
    `${BACKUPS_DIR}/content-studio-data-20260826T103921Z.sql`,
);

const apply = process.argv.includes('--apply');

function decodeCopyValue(value: string): string | null {
  if (value === '\\N') return null;
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
    switch (next) {
      case 't':
        output += '\t';
        i += 1;
        break;
      case 'n':
        output += '\n';
        i += 1;
        break;
      case 'r':
        output += '\r';
        i += 1;
        break;
      case '\\':
        output += '\\';
        i += 1;
        break;
      default:
        output += next;
        i += 1;
        break;
    }
  }
  return output;
}

function parseCopyBlock(sql: string, table: string) {
  const marker = `COPY public.${table} (`;
  const start = sql.indexOf(marker);
  if (start < 0) return { columns: [] as string[], rows: [] as string[][] };

  const headerEnd = sql.indexOf(') FROM stdin;', start);
  const columns = sql
    .slice(start + marker.length, headerEnd)
    .split(',')
    .map((c) => c.trim());

  const dataStart = headerEnd + ') FROM stdin;\n'.length;
  const dataEnd = sql.indexOf('\n\\.\n', dataStart);
  const body = sql.slice(dataStart, dataEnd < 0 ? undefined : dataEnd);
  const rows = body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t').map(decodeCopyValue));

  return { columns, rows };
}

function rowObject(columns: string[], values: Array<string | null>) {
  const out: Record<string, string | null> = {};
  columns.forEach((col, i) => {
    out[col] = values[i] ?? null;
  });
  return out;
}

const knownUsers = new Map<string, boolean>();

async function userExists(userId: string | null) {
  if (!userId) return false;
  const cached = knownUsers.get(userId);
  if (cached !== undefined) return cached;
  const result = await db.query(`SELECT 1 FROM identity.users WHERE id = $1`, [
    userId,
  ]);
  const exists = (result.rowCount ?? 0) > 0;
  knownUsers.set(userId, exists);
  return exists;
}

async function loadIdSet(sql: string) {
  const result = await db.query<{ id: string }>(sql);
  return new Set(result.rows.map((row) => row.id));
}

async function main() {
  for (const source of [CLIENTS_SOURCE, SCHEDULES_SOURCE]) {
    if (!fs.existsSync(source)) {
      throw new Error(`Content Studio export not found: ${source}`);
    }
  }

  const clientsSql = fs.readFileSync(CLIENTS_SOURCE, 'utf8');
  const schedulesSql = fs.readFileSync(SCHEDULES_SOURCE, 'utf8');
  const clients = parseCopyBlock(clientsSql, 'content_clients');
  const schedules = parseCopyBlock(schedulesSql, 'content_review_drafts');

  console.log(
    `[content-studio-migration] clients=${clients.rows.length} schedules=${schedules.rows.length}`,
  );
  console.log(
    `[content-studio-migration] mode=${apply ? 'APPLY' : 'DRY-RUN'} clientsSource=${CLIENTS_SOURCE} schedulesSource=${SCHEDULES_SOURCE}`,
  );

  if (!apply) {
    console.log('Re-run with --apply to import into Kode.');
    return;
  }

  let clientsInserted = 0;
  for (const values of clients.rows) {
    const row = rowObject(clients.columns, values);
    const createdBy = (await userExists(row.created_by)) ? row.created_by : null;
    await db.query(
      `INSERT INTO content.clients (
         id, organization_id, office_id, company_name, contact_name, email, phone,
         internal_reviewer_email, portal_token, login_pin_hash,
         pin_last_generated_at, pin_expires_at, is_active,
         ai_voice_profile, ai_caption_examples, created_by, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         COALESCE($11::timestamptz, NOW()), $12, COALESCE($13::boolean, TRUE),
         COALESCE($14::jsonb, '{}'::jsonb), COALESCE($15::jsonb, '[]'::jsonb),
         $16, COALESCE($17::timestamptz, NOW()), COALESCE($18::timestamptz, NOW())
       )
       ON CONFLICT (id) DO UPDATE SET
         company_name = EXCLUDED.company_name,
         contact_name = EXCLUDED.contact_name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         internal_reviewer_email = EXCLUDED.internal_reviewer_email,
         portal_token = EXCLUDED.portal_token,
         login_pin_hash = EXCLUDED.login_pin_hash,
         pin_last_generated_at = EXCLUDED.pin_last_generated_at,
         pin_expires_at = EXCLUDED.pin_expires_at,
         is_active = EXCLUDED.is_active,
         ai_voice_profile = EXCLUDED.ai_voice_profile,
         ai_caption_examples = EXCLUDED.ai_caption_examples,
         updated_at = EXCLUDED.updated_at`,
      [
        row.id,
        row.organization_id,
        row.office_id,
        row.company_name,
        row.contact_name,
        row.email,
        row.phone,
        row.internal_reviewer_email,
        row.portal_token,
        row.login_pin_hash,
        row.pin_last_generated_at,
        row.pin_expires_at,
        row.is_active,
        row.ai_voice_profile ?? '{}',
        row.ai_caption_examples ?? '[]',
        createdBy,
        row.created_at,
        row.updated_at,
      ],
    );
    clientsInserted += 1;
  }

  let schedulesInserted = 0;
  let schedulesArchivedDupes = 0;
  const seenClientMonths = new Set<string>();
  for (const values of schedules.rows) {
    const row = rowObject(schedules.columns, values);
    if (!row.client_id) continue;
    const createdBy = (await userExists(row.created_by)) ? row.created_by : null;
    const assignedTo = (await userExists(row.assigned_to)) ? row.assigned_to : null;
    let status = row.status || 'draft';

    if (row.scheduled_at && status !== 'archived') {
      const monthKey = `${row.client_id}:${row.scheduled_at.slice(0, 7)}`;
      if (seenClientMonths.has(monthKey)) {
        status = 'archived';
        schedulesArchivedDupes += 1;
      } else {
        seenClientMonths.add(monthKey);
      }
    }
    await db.query(
      `INSERT INTO content.schedules (
         id, organization_id, office_id, client_id, created_by, assigned_to,
         title, subtitle, body, summary, captions, notes, layout_type,
         cta_label, cta_url, review_token, review_url, slug, status, review_status,
         scheduled_at, expires_at, approved_at, approved_by_name, approved_by_email,
         changes_requested_at, last_viewed_at, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,
         $7,$8,$9,$10,$11,$12,COALESCE($13,'article'),
         $14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,
         $26,$27,COALESCE($28::timestamptz, NOW()), COALESCE($29::timestamptz, NOW())
       )
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         status = EXCLUDED.status,
         review_status = EXCLUDED.review_status,
         scheduled_at = EXCLUDED.scheduled_at,
         updated_at = EXCLUDED.updated_at`,
      [
        row.id,
        row.organization_id,
        row.office_id,
        row.client_id,
        createdBy,
        assignedTo,
        row.title,
        row.subtitle,
        row.body,
        row.summary,
        row.captions,
        row.notes,
        row.layout_type,
        row.cta_label,
        row.cta_url,
        row.review_token,
        row.review_url,
        row.slug,
        status,
        row.review_status,
        row.scheduled_at,
        row.expires_at,
        row.approved_at,
        row.approved_by_name,
        row.approved_by_email,
        row.changes_requested_at,
        row.last_viewed_at,
        row.created_at,
        row.updated_at,
      ],
    );
    schedulesInserted += 1;
  }

  const clientIds = await loadIdSet(`SELECT id FROM content.clients`);
  const scheduleIds = await loadIdSet(`SELECT id FROM content.schedules`);
  const libraryMedia = parseCopyBlock(clientsSql, 'content_client_media');
  const assets = parseCopyBlock(schedulesSql, 'content_review_assets');
  const comments = parseCopyBlock(schedulesSql, 'content_review_comments');

  console.log(
    `[content-studio-migration] library_media=${libraryMedia.rows.length} assets=${assets.rows.length} comments=${comments.rows.length}`,
  );

  let mediaInserted = 0;
  let mediaSkipped = 0;
  const seenMediaPaths = new Set<string>();
  for (const values of libraryMedia.rows) {
    const row = rowObject(libraryMedia.columns, values);
    if (!row.id || !row.client_id || !clientIds.has(row.client_id)) {
      mediaSkipped += 1;
      continue;
    }
    if (row.storage_path) {
      const pathKey = `${row.client_id}:${row.storage_path}`;
      if (seenMediaPaths.has(pathKey)) {
        mediaSkipped += 1;
        continue;
      }
      seenMediaPaths.add(pathKey);
    }
    const uploadedBy = (await userExists(row.uploaded_by))
      ? row.uploaded_by
      : null;
    await db.query(
      `INSERT INTO content.client_media (
         id, client_id, organization_id, office_id, uploaded_by,
         file_name, file_url, storage_path, bucket, mime_type, asset_type, label,
         original_size_bytes, stored_size_bytes, compression_status, expires_at, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,$8,'content-review-assets',$9,COALESCE($10,'image'),$11,
         $12,$13,COALESCE($14,'not_applicable'),$15,COALESCE($16::timestamptz, NOW())
       )
       ON CONFLICT (id) DO UPDATE SET
         file_url = EXCLUDED.file_url,
         storage_path = EXCLUDED.storage_path,
         label = EXCLUDED.label,
         expires_at = EXCLUDED.expires_at`,
      [
        row.id,
        row.client_id,
        row.organization_id,
        row.office_id,
        uploadedBy,
        row.file_name,
        row.file_url,
        row.storage_path,
        row.mime_type,
        row.asset_type,
        row.label,
        row.original_size_bytes,
        row.stored_size_bytes,
        row.compression_status,
        row.expires_at,
        row.created_at,
      ],
    );
    mediaInserted += 1;
  }

  const mediaIds = await loadIdSet(`SELECT id FROM content.client_media`);

  let assetsInserted = 0;
  let assetsSkipped = 0;
  for (const values of assets.rows) {
    const row = rowObject(assets.columns, values);
    if (!row.id || !row.draft_id || !scheduleIds.has(row.draft_id)) {
      assetsSkipped += 1;
      continue;
    }
    const uploadedBy = (await userExists(row.uploaded_by))
      ? row.uploaded_by
      : null;
    const libraryMediaId =
      row.library_media_id && mediaIds.has(row.library_media_id)
        ? row.library_media_id
        : null;
    await db.query(
      `INSERT INTO content.schedule_assets (
         id, schedule_id, organization_id, office_id, library_media_id, uploaded_by,
         file_name, file_url, storage_path, bucket, mime_type, asset_type,
         heading, caption, is_selected, crop_x, crop_y, crop_zoom,
         sort_order, display_slot, original_size_bytes, stored_size_bytes,
         compression_status, expires_at, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,
         $7,$8,$9,'content-review-assets',$10,COALESCE($11,'image'),
         $12,$13,COALESCE($14::boolean, TRUE),$15,$16,$17,
         COALESCE($18::int, 0),COALESCE($19::int, 0),$20,$21,
         COALESCE($22,'not_applicable'),$23,COALESCE($24::timestamptz, NOW())
       )
       ON CONFLICT (id) DO UPDATE SET
         file_url = EXCLUDED.file_url,
         caption = EXCLUDED.caption,
         heading = EXCLUDED.heading,
         is_selected = EXCLUDED.is_selected,
         display_slot = EXCLUDED.display_slot,
         library_media_id = EXCLUDED.library_media_id`,
      [
        row.id,
        row.draft_id,
        row.organization_id,
        row.office_id,
        libraryMediaId,
        uploadedBy,
        row.file_name,
        row.file_url,
        row.storage_path,
        row.mime_type,
        row.asset_type,
        row.heading,
        row.caption,
        row.is_selected,
        row.crop_x,
        row.crop_y,
        row.crop_zoom,
        row.sort_order,
        row.display_slot,
        row.original_size_bytes,
        row.stored_size_bytes,
        row.compression_status,
        row.expires_at,
        row.created_at,
      ],
    );
    assetsInserted += 1;
  }

  let commentsInserted = 0;
  let commentsSkipped = 0;
  // Parents first so self-FK succeeds.
  const commentRows = comments.rows
    .map((values) => rowObject(comments.columns, values))
    .filter((row) => row.id && row.draft_id && scheduleIds.has(row.draft_id))
    .sort((a, b) => {
      const aParent = a.parent_comment_id ? 1 : 0;
      const bParent = b.parent_comment_id ? 1 : 0;
      return aParent - bParent;
    });

  const insertedCommentIds = new Set<string>();
  for (const row of commentRows) {
    const body = row.body || row.comment;
    if (!body) {
      commentsSkipped += 1;
      continue;
    }
    const createdBy = (await userExists(row.created_by)) ? row.created_by : null;
    const parentId =
      row.parent_comment_id && insertedCommentIds.has(row.parent_comment_id)
        ? row.parent_comment_id
        : null;
    await db.query(
      `INSERT INTO content.comments (
         id, schedule_id, organization_id, office_id, parent_comment_id,
         author_name, author_email, body, source, visibility, author_type,
         comment_type, display_slot, created_by, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,
         COALESCE($6,'Unknown'),$7,$8,COALESCE($9,'internal'),
         COALESCE($10,'internal'),COALESCE($11,'internal'),
         COALESCE($12,'internal_comment'),$13,$14,COALESCE($15::timestamptz, NOW())
       )
       ON CONFLICT (id) DO UPDATE SET
         body = EXCLUDED.body,
         visibility = EXCLUDED.visibility,
         display_slot = EXCLUDED.display_slot`,
      [
        row.id,
        row.draft_id,
        row.organization_id,
        row.office_id,
        parentId,
        row.author_name,
        row.author_email,
        body,
        row.source,
        row.visibility,
        row.author_type,
        row.comment_type,
        row.display_slot,
        createdBy,
        row.created_at,
      ],
    );
    insertedCommentIds.add(row.id!);
    commentsInserted += 1;
  }
  commentsSkipped += comments.rows.length - commentRows.length;

  const counts = await db.query(`
    SELECT
      (SELECT count(*) FROM content.clients) AS clients,
      (SELECT count(*) FROM content.schedules) AS schedules,
      (SELECT count(*) FROM content.client_media) AS client_media,
      (SELECT count(*) FROM content.schedule_assets) AS schedule_assets,
      (SELECT count(*) FROM content.comments) AS comments
  `);

  console.log(
    `[content-studio-migration] inserted clients=${clientsInserted} schedules=${schedulesInserted} (archived_dupes=${schedulesArchivedDupes}) media=${mediaInserted} (skipped=${mediaSkipped}) assets=${assetsInserted} (skipped=${assetsSkipped}) comments=${commentsInserted} (skipped=${commentsSkipped})`,
  );
  console.log('[content-studio-migration] kode totals', counts.rows[0]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
