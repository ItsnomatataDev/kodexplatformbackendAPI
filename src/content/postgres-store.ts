import { keysetPredicate, listLimit, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { withTransaction, type TransactionClient } from '../db/transaction.js';
import { NotFoundError } from '../http/errors.js';
import type {
  ContentClientMediaRecord,
  ContentClientRecord,
  ContentCommentRecord,
  ContentScheduleAssetRecord,
  ContentScheduleRecord,
  ContentScheduleStatus,
  ContentStore,
  CreateClientInput,
  CreateClientMediaInput,
  CreateScheduleAssetInput,
  CreateScheduleInput,
  UpdateClientInput,
  UpdateScheduleAssetInput,
  UpdateScheduleInput,
} from './store.js';

type ClientRow = {
  id: string;
  organization_id: string;
  office_id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  internal_reviewer_email: string | null;
  portal_token: string;
  login_pin_hash: string;
  pin_last_generated_at: Date;
  pin_expires_at: Date | null;
  is_active: boolean;
  ai_voice_profile: Record<string, unknown> | null;
  ai_caption_examples: unknown[] | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type ScheduleRow = {
  id: string;
  organization_id: string;
  office_id: string;
  client_id: string | null;
  created_by: string | null;
  assigned_to: string | null;
  title: string;
  subtitle: string | null;
  body: string | null;
  summary: string | null;
  captions: string | null;
  notes: string | null;
  layout_type: string;
  cta_label: string | null;
  cta_url: string | null;
  review_token: string;
  review_url: string | null;
  slug: string | null;
  status: ContentScheduleStatus;
  review_status: string | null;
  scheduled_at: Date | null;
  expires_at: Date | null;
  approved_at: Date | null;
  approved_by_name: string | null;
  approved_by_email: string | null;
  changes_requested_at: Date | null;
  last_viewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type MediaRow = {
  id: string;
  client_id: string;
  organization_id: string;
  office_id: string;
  uploaded_by: string | null;
  file_name: string;
  file_url: string;
  storage_path: string | null;
  bucket: string;
  mime_type: string | null;
  asset_type: string;
  label: string | null;
  original_size_bytes: string | number | null;
  stored_size_bytes: string | number | null;
  compression_status: string;
  web_playback_status: string | null;
  expires_at: Date | null;
  created_at: Date;
};

type AssetRow = {
  id: string;
  schedule_id: string;
  organization_id: string;
  office_id: string;
  library_media_id: string | null;
  uploaded_by: string | null;
  file_name: string;
  file_url: string;
  storage_path: string | null;
  bucket: string;
  mime_type: string | null;
  asset_type: string;
  heading: string | null;
  caption: string | null;
  is_selected: boolean;
  crop_x: string | number | null;
  crop_y: string | number | null;
  crop_zoom: string | number | null;
  sort_order: number;
  display_slot: number;
  original_size_bytes: string | number | null;
  stored_size_bytes: string | number | null;
  compression_status: string;
  web_playback_status: string | null;
  expires_at: Date | null;
  created_at: Date;
};

type CommentRow = {
  id: string;
  schedule_id: string;
  organization_id: string;
  office_id: string;
  parent_comment_id: string | null;
  author_name: string;
  author_email: string | null;
  body: string;
  source: string;
  visibility: string;
  author_type: string;
  comment_type: string;
  display_slot: number | null;
  created_by: string | null;
  created_at: Date;
};

function asNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapClient(row: ClientRow): ContentClientRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    companyName: row.company_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    internalReviewerEmail: row.internal_reviewer_email,
    portalToken: row.portal_token,
    loginPinHash: row.login_pin_hash,
    pinLastGeneratedAt: row.pin_last_generated_at,
    pinExpiresAt: row.pin_expires_at,
    isActive: row.is_active,
    aiVoiceProfile: row.ai_voice_profile ?? {},
    aiCaptionExamples: row.ai_caption_examples ?? [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSchedule(row: ScheduleRow): ContentScheduleRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    clientId: row.client_id,
    createdBy: row.created_by,
    assignedTo: row.assigned_to,
    title: row.title,
    subtitle: row.subtitle,
    body: row.body,
    summary: row.summary,
    captions: row.captions,
    notes: row.notes,
    layoutType: row.layout_type,
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    reviewToken: row.review_token,
    reviewUrl: row.review_url,
    slug: row.slug,
    status: row.status,
    reviewStatus: row.review_status,
    scheduledAt: row.scheduled_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    approvedByName: row.approved_by_name,
    approvedByEmail: row.approved_by_email,
    changesRequestedAt: row.changes_requested_at,
    lastViewedAt: row.last_viewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMedia(row: MediaRow): ContentClientMediaRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    uploadedBy: row.uploaded_by,
    fileName: row.file_name,
    fileUrl: row.file_url,
    storagePath: row.storage_path,
    bucket: row.bucket,
    mimeType: row.mime_type,
    assetType: row.asset_type,
    label: row.label,
    originalSizeBytes: asNumber(row.original_size_bytes),
    storedSizeBytes: asNumber(row.stored_size_bytes),
    compressionStatus: row.compression_status,
    webPlaybackStatus: row.web_playback_status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapAsset(row: AssetRow): ContentScheduleAssetRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    libraryMediaId: row.library_media_id,
    uploadedBy: row.uploaded_by,
    fileName: row.file_name,
    fileUrl: row.file_url,
    storagePath: row.storage_path,
    bucket: row.bucket,
    mimeType: row.mime_type,
    assetType: row.asset_type,
    heading: row.heading,
    caption: row.caption,
    isSelected: row.is_selected,
    cropX: asNumber(row.crop_x),
    cropY: asNumber(row.crop_y),
    cropZoom: asNumber(row.crop_zoom),
    sortOrder: row.sort_order,
    displaySlot: row.display_slot,
    originalSizeBytes: asNumber(row.original_size_bytes),
    storedSizeBytes: asNumber(row.stored_size_bytes),
    compressionStatus: row.compression_status,
    webPlaybackStatus: row.web_playback_status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapComment(row: CommentRow): ContentCommentRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    parentCommentId: row.parent_comment_id,
    authorName: row.author_name,
    authorEmail: row.author_email,
    body: row.body,
    source: row.source,
    visibility: row.visibility,
    authorType: row.author_type,
    commentType: row.comment_type,
    displaySlot: row.display_slot,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export class PostgresContentStore implements ContentStore {
  constructor(private readonly connection: Pick<TransactionClient, 'query'> = db) {}

  async withReviewTransaction<T>(organizationId: string, scheduleId: string, work: (store: ContentStore) => Promise<T>): Promise<T> {
    return withTransaction(async (client) => {
      await client.query('SELECT id FROM content.schedules WHERE organization_id = $1 AND id = $2 FOR UPDATE', [organizationId, scheduleId]);
      return work(new PostgresContentStore(client));
    });
  }

  async listClients(organizationId: string, officeId: string, requestedLimit?: number) {
    const limit = listLimit(requestedLimit);
    const result = await this.connection.query<ClientRow>(
      `SELECT * FROM content.clients
       WHERE organization_id = $1 AND office_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [organizationId, officeId, limit],
    );
    return result.rows.map(mapClient);
  }

  async getClient(organizationId: string, officeId: string, clientId: string) {
    const result = await this.connection.query<ClientRow>(
      `SELECT * FROM content.clients
       WHERE organization_id = $1 AND office_id = $2 AND id = $3
       LIMIT 1`,
      [organizationId, officeId, clientId],
    );
    return result.rows[0] ? mapClient(result.rows[0]) : null;
  }

  async getClientByPortalToken(portalToken: string, email: string) {
    const result = await this.connection.query<ClientRow>(
      `SELECT * FROM content.clients
       WHERE portal_token = $1
         AND lower(email) = lower($2)
         AND is_active = TRUE
       LIMIT 1`,
      [portalToken, email.trim()],
    );
    return result.rows[0] ? mapClient(result.rows[0]) : null;
  }

  async listSchedulesForClient(clientId: string, requestedLimit?: number) {
    const limit = listLimit(requestedLimit);
    const result = await this.connection.query<ScheduleRow>(
      `SELECT * FROM content.schedules
       WHERE client_id = $1
         AND status IS DISTINCT FROM 'draft'
         AND status IS DISTINCT FROM 'archived'
       ORDER BY scheduled_at DESC NULLS LAST, created_at DESC, id DESC
       LIMIT $2`,
      [clientId, limit],
    );
    return result.rows.map(mapSchedule);
  }

  async getScheduleForClient(clientId: string, scheduleId: string) {
    const result = await this.connection.query<ScheduleRow>(
      `SELECT * FROM content.schedules
       WHERE id = $1 AND client_id = $2
       LIMIT 1`,
      [scheduleId, clientId],
    );
    return result.rows[0] ? mapSchedule(result.rows[0]) : null;
  }

  async createClient(input: CreateClientInput) {
    const result = await this.connection.query<ClientRow>(
      `INSERT INTO content.clients (
         organization_id, office_id, company_name, contact_name, email, phone,
         internal_reviewer_email, portal_token, login_pin_hash, pin_expires_at, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.organizationId,
        input.officeId,
        input.companyName,
        input.contactName,
        input.email,
        input.phone ?? null,
        input.internalReviewerEmail ?? null,
        input.portalToken,
        input.loginPinHash,
        input.pinExpiresAt ?? null,
        input.createdBy,
      ],
    );
    return mapClient(result.rows[0]!);
  }

  async updateClient(
    organizationId: string,
    officeId: string,
    clientId: string,
    input: UpdateClientInput,
  ) {
    const result = await this.connection.query<ClientRow>(
      `UPDATE content.clients SET
         company_name = COALESCE($4, company_name),
         contact_name = COALESCE($5, contact_name),
         email = COALESCE($6, email),
         phone = CASE WHEN $7::boolean THEN $8 ELSE phone END,
         internal_reviewer_email = CASE WHEN $9::boolean THEN $10 ELSE internal_reviewer_email END,
         ai_voice_profile = COALESCE($11, ai_voice_profile),
         ai_caption_examples = COALESCE($12, ai_caption_examples),
         login_pin_hash = COALESCE($13, login_pin_hash),
         pin_last_generated_at = COALESCE($14, pin_last_generated_at),
         pin_expires_at = CASE WHEN $15::boolean THEN $16 ELSE pin_expires_at END,
         updated_at = NOW()
       WHERE organization_id = $1 AND office_id = $2 AND id = $3
       RETURNING *`,
      [
        organizationId,
        officeId,
        clientId,
        input.companyName ?? null,
        input.contactName ?? null,
        input.email ?? null,
        input.phone !== undefined,
        input.phone ?? null,
        input.internalReviewerEmail !== undefined,
        input.internalReviewerEmail ?? null,
        input.aiVoiceProfile ? JSON.stringify(input.aiVoiceProfile) : null,
        input.aiCaptionExamples ? JSON.stringify(input.aiCaptionExamples) : null,
        input.loginPinHash ?? null,
        input.pinLastGeneratedAt ?? null,
        input.pinExpiresAt !== undefined,
        input.pinExpiresAt ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('CONTENT_CLIENT_NOT_FOUND', 'Client was not found.');
    }
    return mapClient(result.rows[0]);
  }

  async deleteClient(organizationId: string, officeId: string, clientId: string) {
    const result = await this.connection.query(
      `DELETE FROM content.clients
       WHERE organization_id = $1 AND office_id = $2 AND id = $3`,
      [organizationId, officeId, clientId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundError('CONTENT_CLIENT_NOT_FOUND', 'Client was not found.');
    }
  }

  async findScheduleForMonth(params: {
    organizationId: string;
    officeId: string;
    clientId: string;
    monthKey: string;
  }) {
    const result = await this.connection.query<ScheduleRow>(
      `SELECT * FROM content.schedules
       WHERE organization_id = $1
         AND office_id = $2
         AND client_id = $3
         AND status IS DISTINCT FROM 'archived'
         AND to_char(COALESCE(scheduled_at, created_at) AT TIME ZONE 'UTC', 'YYYY-MM') = $4
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [params.organizationId, params.officeId, params.clientId, params.monthKey],
    );
    return result.rows[0] ? mapSchedule(result.rows[0]) : null;
  }

  async listSchedules(params: {
    organizationId: string;
    officeId: string;
    clientId?: string;
    status?: ContentScheduleStatus | 'all';
    includeArchived?: boolean;
    limit?: number;
  }) {
    const values: unknown[] = [params.organizationId, params.officeId];
    const clauses = ['organization_id = $1', 'office_id = $2'];

    if (params.clientId) {
      values.push(params.clientId);
      clauses.push(`client_id = $${values.length}`);
    }
    if (params.status && params.status !== 'all') {
      values.push(params.status);
      clauses.push(`status = $${values.length}`);
    } else if (!params.includeArchived) {
      clauses.push(`status IS DISTINCT FROM 'archived'`);
    }

    values.push(listLimit(params.limit));
    const result = await this.connection.query<ScheduleRow>(
      `SELECT * FROM content.schedules
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapSchedule);
  }

  async getSchedule(organizationId: string, scheduleId: string) {
    const result = await this.connection.query<ScheduleRow>(
      `SELECT * FROM content.schedules
       WHERE organization_id = $1 AND id = $2
       LIMIT 1`,
      [organizationId, scheduleId],
    );
    return result.rows[0] ? mapSchedule(result.rows[0]) : null;
  }

  async getScheduleByReviewToken(reviewToken: string) {
    const result = await this.connection.query<ScheduleRow>(
      `SELECT * FROM content.schedules
       WHERE review_token = $1
       LIMIT 1`,
      [reviewToken],
    );
    return result.rows[0] ? mapSchedule(result.rows[0]) : null;
  }

  async createSchedule(input: CreateScheduleInput) {
    const result = await this.connection.query<ScheduleRow>(
      `INSERT INTO content.schedules (
         organization_id, office_id, client_id, created_by, title, layout_type,
         review_token, review_url, status, review_status, scheduled_at, expires_at,
         body, captions, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.organizationId,
        input.officeId,
        input.clientId ?? null,
        input.createdBy,
        input.title,
        input.layoutType ?? 'article',
        input.reviewToken,
        input.reviewUrl ?? null,
        input.status ?? 'draft',
        input.reviewStatus ?? null,
        input.scheduledAt ?? null,
        input.expiresAt ?? null,
        input.body ?? null,
        input.captions ?? null,
        input.notes ?? null,
      ],
    );
    return mapSchedule(result.rows[0]!);
  }

  async updateSchedule(
    organizationId: string,
    scheduleId: string,
    input: UpdateScheduleInput,
  ) {
    const result = await this.connection.query<ScheduleRow>(
      `UPDATE content.schedules SET
         title = COALESCE($3, title),
         subtitle = CASE WHEN $4::boolean THEN $5 ELSE subtitle END,
         body = CASE WHEN $6::boolean THEN $7 ELSE body END,
         summary = CASE WHEN $8::boolean THEN $9 ELSE summary END,
         captions = CASE WHEN $10::boolean THEN $11 ELSE captions END,
         notes = CASE WHEN $12::boolean THEN $13 ELSE notes END,
         layout_type = COALESCE($14, layout_type),
         cta_label = CASE WHEN $15::boolean THEN $16 ELSE cta_label END,
         cta_url = CASE WHEN $17::boolean THEN $18 ELSE cta_url END,
         review_token = COALESCE($19, review_token),
         review_url = CASE WHEN $20::boolean THEN $21 ELSE review_url END,
         status = COALESCE($22, status),
         review_status = CASE WHEN $23::boolean THEN $24 ELSE review_status END,
         scheduled_at = CASE WHEN $25::boolean THEN $26 ELSE scheduled_at END,
         expires_at = CASE WHEN $27::boolean THEN $28 ELSE expires_at END,
         client_id = CASE WHEN $29::boolean THEN $30 ELSE client_id END,
         assigned_to = CASE WHEN $31::boolean THEN $32 ELSE assigned_to END,
         last_viewed_at = CASE WHEN $33::boolean THEN $34 ELSE last_viewed_at END,
         approved_at = CASE WHEN $35::boolean THEN $36 ELSE approved_at END,
         approved_by_name = CASE WHEN $37::boolean THEN $38 ELSE approved_by_name END,
         approved_by_email = CASE WHEN $39::boolean THEN $40 ELSE approved_by_email END,
         changes_requested_at = CASE WHEN $41::boolean THEN $42 ELSE changes_requested_at END,
         updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        scheduleId,
        input.title ?? null,
        input.subtitle !== undefined,
        input.subtitle ?? null,
        input.body !== undefined,
        input.body ?? null,
        input.summary !== undefined,
        input.summary ?? null,
        input.captions !== undefined,
        input.captions ?? null,
        input.notes !== undefined,
        input.notes ?? null,
        input.layoutType ?? null,
        input.ctaLabel !== undefined,
        input.ctaLabel ?? null,
        input.ctaUrl !== undefined,
        input.ctaUrl ?? null,
        input.reviewToken ?? null,
        input.reviewUrl !== undefined,
        input.reviewUrl ?? null,
        input.status ?? null,
        input.reviewStatus !== undefined,
        input.reviewStatus ?? null,
        input.scheduledAt !== undefined,
        input.scheduledAt ?? null,
        input.expiresAt !== undefined,
        input.expiresAt ?? null,
        input.clientId !== undefined,
        input.clientId ?? null,
        input.assignedTo !== undefined,
        input.assignedTo ?? null,
        input.lastViewedAt !== undefined,
        input.lastViewedAt ?? null,
        input.approvedAt !== undefined,
        input.approvedAt ?? null,
        input.approvedByName !== undefined,
        input.approvedByName ?? null,
        input.approvedByEmail !== undefined,
        input.approvedByEmail ?? null,
        input.changesRequestedAt !== undefined,
        input.changesRequestedAt ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'CONTENT_SCHEDULE_NOT_FOUND',
        'Schedule was not found.',
      );
    }
    return mapSchedule(result.rows[0]);
  }

  async deleteSchedule(organizationId: string, scheduleId: string) {
    const result = await this.connection.query(
      `DELETE FROM content.schedules WHERE organization_id = $1 AND id = $2`,
      [organizationId, scheduleId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundError(
        'CONTENT_SCHEDULE_NOT_FOUND',
        'Schedule was not found.',
      );
    }
  }

  async listAssetsForSchedules(organizationId: string, scheduleIds: string[]) {
    if (scheduleIds.length === 0) return [];
    const result = await this.connection.query<AssetRow>(
      `SELECT * FROM content.schedule_assets
       WHERE organization_id = $1 AND schedule_id = ANY($2::uuid[])
       ORDER BY display_slot ASC, sort_order ASC, created_at ASC`,
      [organizationId, scheduleIds],
    );
    return result.rows.map(mapAsset);
  }

  async getAsset(organizationId: string, assetId: string) {
    const result = await this.connection.query<AssetRow>(
      `SELECT * FROM content.schedule_assets
       WHERE organization_id = $1 AND id = $2
       LIMIT 1`,
      [organizationId, assetId],
    );
    return result.rows[0] ? mapAsset(result.rows[0]) : null;
  }

  async createAsset(input: CreateScheduleAssetInput, query: Pick<TransactionClient, 'query'> = db) {
    const result = await query.query<AssetRow>(
      `INSERT INTO content.schedule_assets (
         id, schedule_id, organization_id, office_id, library_media_id, uploaded_by,
         file_name, file_url, storage_path, bucket, mime_type, asset_type,
         heading, caption, is_selected, crop_x, crop_y, crop_zoom,
         sort_order, display_slot, original_size_bytes, stored_size_bytes,
         compression_status, web_playback_status, expires_at
       ) VALUES (
         COALESCE($1, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
       )
       RETURNING *`,
      [
        input.id ?? null,
        input.scheduleId,
        input.organizationId,
        input.officeId,
        input.libraryMediaId ?? null,
        input.uploadedBy,
        input.fileName,
        input.fileUrl,
        input.storagePath,
        input.bucket,
        input.mimeType ?? null,
        input.assetType,
        input.heading ?? null,
        input.caption ?? null,
        input.isSelected ?? true,
        input.cropX ?? 50,
        input.cropY ?? 50,
        input.cropZoom ?? 1,
        input.sortOrder ?? 0,
        input.displaySlot ?? 0,
        input.originalSizeBytes ?? null,
        input.storedSizeBytes ?? null,
        input.compressionStatus ?? 'not_applicable',
        input.webPlaybackStatus ?? null,
        input.expiresAt ?? null,
      ],
    );
    return mapAsset(result.rows[0]!);
  }

  async createUploadedAsset(input: CreateScheduleAssetInput, clientId: string | null) {
    return withTransaction(async (query) => {
      const media = clientId ? await this.createClientMedia({
        ...input, clientId,
      }, query) : null;
      return this.createAsset({ ...input, libraryMediaId: media?.id ?? null }, query);
    });
  }

  async updateAsset(
    organizationId: string,
    assetId: string,
    input: UpdateScheduleAssetInput,
  ) {
    const result = await this.connection.query<AssetRow>(
      `UPDATE content.schedule_assets SET
         heading = CASE WHEN $3::boolean THEN $4 ELSE heading END,
         caption = CASE WHEN $5::boolean THEN $6 ELSE caption END,
         is_selected = COALESCE($7, is_selected),
         crop_x = CASE WHEN $8::boolean THEN $9 ELSE crop_x END,
         crop_y = CASE WHEN $10::boolean THEN $11 ELSE crop_y END,
         crop_zoom = CASE WHEN $12::boolean THEN $13 ELSE crop_zoom END,
         sort_order = COALESCE($14, sort_order),
         display_slot = COALESCE($15, display_slot)
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        assetId,
        input.heading !== undefined,
        input.heading ?? null,
        input.caption !== undefined,
        input.caption ?? null,
        input.isSelected ?? null,
        input.cropX !== undefined,
        input.cropX ?? null,
        input.cropY !== undefined,
        input.cropY ?? null,
        input.cropZoom !== undefined,
        input.cropZoom ?? null,
        input.sortOrder ?? null,
        input.displaySlot ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('CONTENT_ASSET_NOT_FOUND', 'Asset was not found.');
    }
    return mapAsset(result.rows[0]);
  }

  async setAssetsSelected(
    organizationId: string,
    assetIds: string[],
    isSelected: boolean,
  ) {
    if (assetIds.length === 0) return;
    await this.connection.query(
      `UPDATE content.schedule_assets
       SET is_selected = $3
       WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, assetIds, isSelected],
    );
  }

  async deleteAsset(organizationId: string, assetId: string) {
    const result = await this.connection.query<AssetRow>(
      `DELETE FROM content.schedule_assets
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [organizationId, assetId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('CONTENT_ASSET_NOT_FOUND', 'Asset was not found.');
    }
    return mapAsset(result.rows[0]);
  }

  async countAssetsUsingStoragePath(organizationId: string, storagePath: string) {
    const result = await this.connection.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM content.schedule_assets
       WHERE organization_id = $1 AND storage_path = $2`,
      [organizationId, storagePath],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async findMediaOwnership(organizationId: string, storagePath: string) {
    const result = await this.connection.query(
      `SELECT 1 FROM content.schedule_assets
         WHERE organization_id = $1 AND storage_path = $2
       UNION ALL
       SELECT 1 FROM content.client_media
         WHERE organization_id = $1 AND storage_path = $2
       LIMIT 1`,
      [organizationId, storagePath],
    );
    return result.rows.length > 0;
  }

  async listClientMedia(
    organizationId: string,
    clientId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId, clientId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
    );
    params.push(limit + 1);
    const result = await this.connection.query<MediaRow>(
      `SELECT * FROM content.client_media
       WHERE organization_id = $1 AND client_id = $2
         ${cursor}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map(mapMedia), limit);
    return { media: paged.rows, hasMore: paged.hasMore };
  }

  async getClientMedia(organizationId: string, mediaId: string) {
    const result = await this.connection.query<MediaRow>(
      `SELECT * FROM content.client_media
       WHERE organization_id = $1 AND id = $2
       LIMIT 1`,
      [organizationId, mediaId],
    );
    return result.rows[0] ? mapMedia(result.rows[0]) : null;
  }

  async createClientMedia(input: CreateClientMediaInput, query: Pick<TransactionClient, 'query'> = db) {
    const result = await query.query<MediaRow>(
      `INSERT INTO content.client_media (
         id, client_id, organization_id, office_id, uploaded_by,
         file_name, file_url, storage_path, bucket, mime_type, asset_type, label,
         original_size_bytes, stored_size_bytes, compression_status,
         web_playback_status, expires_at
       ) VALUES (
         COALESCE($1, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17
       )
       RETURNING *`,
      [
        input.id ?? null,
        input.clientId,
        input.organizationId,
        input.officeId,
        input.uploadedBy,
        input.fileName,
        input.fileUrl,
        input.storagePath,
        input.bucket,
        input.mimeType ?? null,
        input.assetType,
        input.label ?? null,
        input.originalSizeBytes ?? null,
        input.storedSizeBytes ?? null,
        input.compressionStatus ?? 'not_applicable',
        input.webPlaybackStatus ?? null,
        input.expiresAt ?? null,
      ],
    );
    return mapMedia(result.rows[0]!);
  }

  async deleteClientMedia(organizationId: string, mediaId: string) {
    const result = await this.connection.query<MediaRow>(
      `DELETE FROM content.client_media
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [organizationId, mediaId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('CONTENT_MEDIA_NOT_FOUND', 'Media was not found.');
    }
    return mapMedia(result.rows[0]);
  }

  async countLibraryRefs(organizationId: string, mediaId: string) {
    const result = await this.connection.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM content.schedule_assets
       WHERE organization_id = $1 AND library_media_id = $2`,
      [organizationId, mediaId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countClientMediaUsingPath(organizationId: string, storagePath: string) {
    const result = await this.connection.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM content.client_media
       WHERE organization_id = $1 AND storage_path = $2`,
      [organizationId, storagePath],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listComments(organizationId: string, scheduleIds: string[]) {
    if (scheduleIds.length === 0) return [];
    const result = await this.connection.query<CommentRow>(
      `SELECT * FROM content.comments
       WHERE organization_id = $1 AND schedule_id = ANY($2::uuid[])
       ORDER BY created_at ASC`,
      [organizationId, scheduleIds],
    );
    return result.rows.map(mapComment);
  }

  async listActivity(organizationId: string, scheduleIds: string[]) {
    if (scheduleIds.length === 0) return [];
    const result = await this.connection.query<{
      id: string;
      schedule_id: string;
      organization_id: string;
      office_id: string;
      actor_user_id: string | null;
      activity_type: string;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `SELECT * FROM content.activity
       WHERE organization_id = $1 AND schedule_id = ANY($2::uuid[])
       ORDER BY created_at DESC`,
      [organizationId, scheduleIds],
    );
    return result.rows.map((row) => ({
      id: row.id,
      scheduleId: row.schedule_id,
      organizationId: row.organization_id,
      officeId: row.office_id,
      actorUserId: row.actor_user_id,
      activityType: row.activity_type,
      metadata:
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? row.metadata
          : {},
      createdAt: row.created_at,
    }));
  }

  async addComment(input: {
    scheduleId: string;
    organizationId: string;
    officeId: string;
    authorName: string;
    authorEmail?: string | null;
    body: string;
    createdBy?: string | null;
    displaySlot?: number | null;
    source?: string;
    visibility?: string;
    authorType?: string;
    commentType?: string;
    parentCommentId?: string | null;
  }) {
    const result = await this.connection.query<CommentRow>(
      `INSERT INTO content.comments (
         schedule_id, organization_id, office_id, parent_comment_id,
         author_name, author_email, body, source, visibility, author_type,
         comment_type, display_slot, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        input.scheduleId,
        input.organizationId,
        input.officeId,
        input.parentCommentId ?? null,
        input.authorName,
        input.authorEmail ?? null,
        input.body,
        input.source ?? 'internal',
        input.visibility ?? 'internal',
        input.authorType ?? 'internal',
        input.commentType ?? 'internal_comment',
        input.displaySlot ?? null,
        input.createdBy ?? null,
      ],
    );
    return mapComment(result.rows[0]!);
  }

  async recordActivity(input: {
    scheduleId: string;
    organizationId: string;
    officeId: string;
    actorUserId: string | null;
    activityType: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.connection.query(
      `INSERT INTO content.activity (
         schedule_id, organization_id, office_id, actor_user_id, activity_type, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        input.scheduleId,
        input.organizationId,
        input.officeId,
        input.actorUserId,
        input.activityType,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }
}
