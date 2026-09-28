import { submitInternalReview } from '../content/internal-review.js';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { isUuid } from '../auth/uuid.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../http/errors.js';
import { env } from '../config/env.js';
import { decodeStrictBase64 } from '../http/base64.js';
import { readListQuery } from '../http/list-query.js';
import { FIELD_LIMITS } from '../http/limits.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import type { FileStorage } from '../files/storage.js';
import type { OrganizationDirectoryStore } from '../organizations/store.js';
import type {
  ContentClientMediaRecord,
  ContentClientRecord,
  ContentCommentRecord,
  ContentScheduleAssetRecord,
  ContentScheduleRecord,
  ContentScheduleStatus,
  ContentStore,
} from '../content/store.js';
import {
  CONTENT_ASSET_KEEP_UNTIL,
  CONTENT_REVIEW_ASSETS_BUCKET,
  contentAssetTypeFromMime,
  contentClientObjectKey,
  contentScheduleObjectKey,
} from '../content/buckets.js';
import { logger } from '../config/logger.js';
import { persistMediaUpload } from '../content/upload.js';
import { streamStoredMedia } from '../content/media-stream.js';
import { sharedMediaCapabilityStore } from '../content/redis-capability.js';
import { mediaCapabilityStore } from '../content/media-capability.js';
import {
  contentReviewLinkExpiresAt,
  generateContentReviewToken,
  generateNumericPin,
  generatePortalToken,
  hashClientPin,
} from '../content/pin.js';

export type ContentStudioRouteDependencies = {
  store: ContentStore;
  files: FileStorage;
  directory: OrganizationDirectoryStore;
};

const CONTENT_STUDIO_BLOCKED_OFFICE_SLUGS = new Set(['three-little-birds']);

function authorizeContent(
  auth: ReturnType<typeof getAuth>,
  action: string,
) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: { type: 'content_studio', organizationId },
  });
  return organizationId;
}

function requireOfficeId(auth: ReturnType<typeof getAuth>, bodyOfficeId?: string | null) {
  const officeId = (bodyOfficeId ?? auth.membership.officeId ?? '').trim();
  if (!officeId) {
    throw new ValidationError(
      'Your profile must be assigned to a Content Studio office.',
      { field: 'officeId' },
    );
  }
  return officeId;
}

async function assertContentStudioOffice(params: {
  directory: OrganizationDirectoryStore;
  organizationId: string;
  officeId: string;
}) {
  const office = await params.directory.getOffice(
    params.organizationId,
    params.officeId,
  );
  if (!office) {
    throw new NotFoundError('OFFICE_NOT_FOUND', 'Office was not found.');
  }
  const slug = (office.slug ?? '').toLowerCase();
  if (CONTENT_STUDIO_BLOCKED_OFFICE_SLUGS.has(slug)) {
    throw new ForbiddenError(
      'CONTENT_STUDIO_OFFICE_BLOCKED',
      'Content Studio is not available for the Three Little Birds office.',
    );
  }
  return office;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function serializeClient(row: ContentClientRecord) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    officeId: row.officeId,
    companyName: row.companyName,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    internalReviewerEmail: row.internalReviewerEmail,
    portalToken: row.portalToken,
    pinLastGeneratedAt: iso(row.pinLastGeneratedAt),
    pinExpiresAt: iso(row.pinExpiresAt),
    isActive: row.isActive,
    aiVoiceProfile: row.aiVoiceProfile,
    aiCaptionExamples: row.aiCaptionExamples,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function serializeSchedule(row: ContentScheduleRecord) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    officeId: row.officeId,
    clientId: row.clientId,
    createdBy: row.createdBy,
    assignedTo: row.assignedTo,
    title: row.title,
    subtitle: row.subtitle,
    body: row.body,
    summary: row.summary,
    captions: row.captions,
    notes: row.notes,
    layoutType: row.layoutType,
    ctaLabel: row.ctaLabel,
    ctaUrl: row.ctaUrl,
    reviewToken: row.reviewToken,
    reviewUrl: row.reviewUrl,
    slug: row.slug,
    status: row.status,
    reviewStatus: row.reviewStatus,
    scheduledAt: iso(row.scheduledAt),
    expiresAt: iso(row.expiresAt),
    approvedAt: iso(row.approvedAt),
    approvedByName: row.approvedByName,
    approvedByEmail: row.approvedByEmail,
    changesRequestedAt: iso(row.changesRequestedAt),
    lastViewedAt: iso(row.lastViewedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function serializeAsset(row: ContentScheduleAssetRecord) {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    draftId: row.scheduleId,
    organizationId: row.organizationId,
    officeId: row.officeId,
    libraryMediaId: row.libraryMediaId,
    uploadedBy: row.uploadedBy,
    fileName: row.fileName,
    fileUrl: resolveStoredMediaUrl(row.fileUrl, row.storagePath),
    storagePath: row.storagePath,
    bucket: row.bucket,
    mimeType: row.mimeType,
    assetType: row.assetType,
    heading: row.heading,
    caption: row.caption,
    isSelected: row.isSelected,
    cropX: row.cropX,
    cropY: row.cropY,
    cropZoom: row.cropZoom,
    sortOrder: row.sortOrder,
    displaySlot: row.displaySlot,
    originalSizeBytes: row.originalSizeBytes,
    storedSizeBytes: row.storedSizeBytes,
    compressionStatus: row.compressionStatus,
    webPlaybackStatus: row.webPlaybackStatus,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

function serializeMedia(row: ContentClientMediaRecord) {
  return {
    id: row.id,
    clientId: row.clientId,
    organizationId: row.organizationId,
    officeId: row.officeId,
    uploadedBy: row.uploadedBy,
    fileName: row.fileName,
    fileUrl: resolveStoredMediaUrl(row.fileUrl, row.storagePath),
    storagePath: row.storagePath,
    bucket: row.bucket,
    mimeType: row.mimeType,
    assetType: row.assetType,
    label: row.label,
    originalSizeBytes: row.originalSizeBytes,
    storedSizeBytes: row.storedSizeBytes,
    compressionStatus: row.compressionStatus,
    webPlaybackStatus: row.webPlaybackStatus,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

function serializeComment(row: ContentCommentRecord) {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    draftId: row.scheduleId,
    organizationId: row.organizationId,
    officeId: row.officeId,
    parentCommentId: row.parentCommentId,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    body: row.body,
    comment: row.body,
    source: row.source,
    visibility: row.visibility,
    authorType: row.authorType,
    commentType: row.commentType,
    displaySlot: row.displaySlot,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

function serializeActivity(row: {
  id: string;
  scheduleId: string;
  organizationId: string;
  officeId: string;
  actorUserId: string | null;
  activityType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}) {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    draftId: row.scheduleId,
    organizationId: row.organizationId,
    officeId: row.officeId,
    actorUserId: row.actorUserId,
    activityType: row.activityType,
    metadata: row.metadata,
    createdAt: iso(row.createdAt),
  };
}

function scheduleMonthKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function scheduleMonthStart(monthKey: string) {
  return new Date(`${monthKey}-01T08:00:00.000Z`);
}

function defaultScheduleTitle(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  const label = new Date(Date.UTC(year!, month! - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${label} schedule`;
}

function mediaProxyUrl(objectKey: string) {
  return `/api/content-studio/media?objectKey=${encodeURIComponent(objectKey)}`;
}

/** Prefer MinIO proxy for migrated rows that still carry legacy Supabase URLs. */
function resolveStoredMediaUrl(fileUrl: string, storagePath: string | null) {
  if (
    storagePath &&
    /^[0-9a-f-]{36}\//i.test(storagePath) &&
    (fileUrl.includes('supabase.co') ||
      fileUrl.startsWith('storage://') ||
      fileUrl.includes('/object/public/content-review-assets/'))
  ) {
    return mediaProxyUrl(storagePath);
  }
  return fileUrl;
}

function decodeUploadFilename(raw: string | undefined) {
  if (!raw?.trim()) {
    throw new ValidationError('filename is required.', { field: 'filename' });
  }
  try {
    return readRequiredText(decodeURIComponent(raw.trim()), 'filename', FIELD_LIMITS.filename);
  } catch {
    return readRequiredText(raw.trim(), 'filename', FIELD_LIMITS.filename);
  }
}

function requireBinaryUploadSize(c: { req: { header: (name: string) => string | undefined } }) {
  const declared = c.req.header('content-length');
  if (declared == null || declared === '') {
    throw new ValidationError('Content-Length is required for binary uploads.', {
      field: 'Content-Length',
    });
  }
  const size = Number(declared);
  if (!Number.isInteger(size) || size < 0) {
    throw new ValidationError('Invalid Content-Length header.', {
      field: 'Content-Length',
    });
  }
  const maxBytes =
    env.limits.maxContentStudioUploadBytes ?? 1024 * 1024 * 1024;
  if (size > maxBytes) {
    throw new PayloadTooLargeError(
      `File exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB Content Studio upload limit.`,
    );
  }
  if (size === 0) {
    throw new ValidationError('Empty uploads are not allowed.', { field: 'body' });
  }
  return size;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return asOptionalNumber(value);
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asScheduleStatus(value: unknown): ContentScheduleStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const allowed: ContentScheduleStatus[] = [
    'draft',
    'ready_for_review',
    'sent_to_client',
    'viewed',
    'changes_requested',
    'approved',
    'published',
    'archived',
  ];
  return allowed.includes(value as ContentScheduleStatus)
    ? (value as ContentScheduleStatus)
    : undefined;
}

function readMediaObjectKey(raw: string | undefined | null) {
  let value = (raw ?? '').trim();
  if (!value) return '';
  if (value.includes('%')) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded) value = decoded;
    } catch {
      // keep original
    }
  }
  return value;
}

export function createContentStudioRoutes(
  dependencies: ContentStudioRouteDependencies,
) {
  const routes = new Hono();
  const capabilities = env.appEnv === 'development' ? mediaCapabilityStore : sharedMediaCapabilityStore();

  routes.get('/clients', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.read');
    const officeId = requireOfficeId(auth, c.req.query('officeId'));
    await assertContentStudioOffice({
      directory: dependencies.directory,
      organizationId,
      officeId,
    });
    const clients = await dependencies.store.listClients(organizationId, officeId);
    return c.json({ clients: clients.map(serializeClient) });
  });

  routes.get('/clients/:clientId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.read');
    const officeId = requireOfficeId(auth, c.req.query('officeId'));
    const clientId = requireUuidValue(c.req.param('clientId'), 'clientId');
    const client = await dependencies.store.getClient(
      organizationId,
      officeId,
      clientId,
    );
    if (!client) {
      throw new NotFoundError('CONTENT_CLIENT_NOT_FOUND', 'Client was not found.');
    }
    return c.json({ client: serializeClient(client) });
  });

  routes.post('/clients', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const body = await readJson(c);
    const officeId = requireOfficeId(
      auth,
      readOptionalString(body.officeId, 'officeId', 80),
    );
    await assertContentStudioOffice({
      directory: dependencies.directory,
      organizationId,
      officeId,
    });

    const portalToken = generatePortalToken();
    const pin = generateNumericPin(6);
    const client = await dependencies.store.createClient({
      organizationId,
      officeId,
      companyName: readRequiredText(body.companyName ?? body.company_name, 'companyName', 200),
      contactName: readRequiredText(body.contactName ?? body.contact_name, 'contactName', 200),
      email: readRequiredText(body.email, 'email', 320).toLowerCase(),
      phone: readOptionalString(body.phone, 'phone', 80),
      internalReviewerEmail: readOptionalString(
        body.internalReviewerEmail ?? body.internal_reviewer_email,
        'internalReviewerEmail',
        320,
      ),
      portalToken,
      loginPinHash: hashClientPin(portalToken, pin),
      pinExpiresAt: contentReviewLinkExpiresAt(90),
      createdBy: auth.actor.userId,
    });

    return c.json({ client: serializeClient(client), pin }, 201);
  });

  routes.patch('/clients/:clientId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const clientId = requireUuidValue(c.req.param('clientId'), 'clientId');
    const body = await readJson(c);
    const officeId = requireOfficeId(
      auth,
      readOptionalString(body.officeId, 'officeId', 80),
    );
    const client = await dependencies.store.updateClient(
      organizationId,
      officeId,
      clientId,
      {
        companyName: asOptionalString(body.companyName ?? body.company_name),
        contactName: asOptionalString(body.contactName ?? body.contact_name),
        email: asOptionalString(body.email),
        phone: asNullableString(body.phone),
        internalReviewerEmail: asNullableString(
          body.internalReviewerEmail ?? body.internal_reviewer_email,
        ),
        aiVoiceProfile:
          body.aiVoiceProfile && typeof body.aiVoiceProfile === 'object'
            ? (body.aiVoiceProfile as Record<string, unknown>)
            : body.ai_voice_profile && typeof body.ai_voice_profile === 'object'
              ? (body.ai_voice_profile as Record<string, unknown>)
              : undefined,
        aiCaptionExamples: Array.isArray(body.aiCaptionExamples)
          ? body.aiCaptionExamples
          : Array.isArray(body.ai_caption_examples)
            ? body.ai_caption_examples
            : undefined,
      },
    );
    return c.json({ client: serializeClient(client) });
  });

  routes.post('/clients/:clientId/pin', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const clientId = requireUuidValue(c.req.param('clientId'), 'clientId');
    const body = await readJson(c).catch(() => ({}));
    const officeId = requireOfficeId(
      auth,
      readOptionalString((body as { officeId?: string }).officeId, 'officeId', 80),
    );
    const existing = await dependencies.store.getClient(
      organizationId,
      officeId,
      clientId,
    );
    if (!existing) {
      throw new NotFoundError('CONTENT_CLIENT_NOT_FOUND', 'Client was not found.');
    }
    const pin = generateNumericPin(6);
    const client = await dependencies.store.updateClient(
      organizationId,
      officeId,
      clientId,
      {
        loginPinHash: hashClientPin(existing.portalToken, pin),
        pinLastGeneratedAt: new Date(),
        pinExpiresAt: contentReviewLinkExpiresAt(90),
      },
    );
    return c.json({ client: serializeClient(client), pin });
  });

  routes.delete('/clients/:clientId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const clientId = requireUuidValue(c.req.param('clientId'), 'clientId');
    const officeId = requireOfficeId(auth, c.req.query('officeId'));
    await dependencies.store.deleteClient(organizationId, officeId, clientId);
    return c.json({ ok: true });
  });

  routes.get('/schedules', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.read');
    const officeId = requireOfficeId(auth, c.req.query('officeId'));
    const clientId = c.req.query('clientId') || undefined;
    const status = (c.req.query('status') as ContentScheduleStatus | 'all' | undefined) ??
      'all';
    const schedules = await dependencies.store.listSchedules({
      organizationId,
      officeId,
      clientId,
      status,
      includeArchived: c.req.query('includeArchived') === 'true',
    });
    return c.json({ schedules: schedules.map(serializeSchedule) });
  });

  routes.post('/schedules', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const body = await readJson(c);
    const officeId = requireOfficeId(
      auth,
      readOptionalString(body.officeId, 'officeId', 80),
    );
    await assertContentStudioOffice({
      directory: dependencies.directory,
      organizationId,
      officeId,
    });

    const reviewToken = generateContentReviewToken();
    const schedule = await dependencies.store.createSchedule({
      organizationId,
      officeId,
      clientId: body.clientId
        ? requireUuidValue(String(body.clientId), 'clientId')
        : null,
      createdBy: auth.actor.userId,
      title: readRequiredText(body.title, 'title', 300),
      reviewToken,
      reviewUrl: `/internal-preview/${reviewToken}`,
      layoutType: readOptionalString(body.layoutType, 'layoutType', 80) ?? 'article',
      status: (body.status as ContentScheduleStatus | undefined) ?? 'draft',
      reviewStatus: readOptionalString(body.reviewStatus, 'reviewStatus', 80),
      scheduledAt: body.scheduledAt ? new Date(String(body.scheduledAt)) : null,
      expiresAt: contentReviewLinkExpiresAt(90),
      body: readOptionalString(body.body, 'body', FIELD_LIMITS.cardDescription),
      captions: readOptionalString(body.captions, 'captions', FIELD_LIMITS.cardDescription),
      notes: readOptionalString(body.notes, 'notes', FIELD_LIMITS.cardDescription),
    });

    await dependencies.store.recordActivity({
      scheduleId: schedule.id,
      organizationId,
      officeId,
      actorUserId: auth.actor.userId,
      activityType: 'schedule_created',
    });

    return c.json({ schedule: serializeSchedule(schedule) }, 201);
  });

  routes.post('/clients/:clientId/ensure-month', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const clientId = requireUuidValue(c.req.param('clientId'), 'clientId');
    const body = await readJson(c).catch(() => ({}));
    const officeId = requireOfficeId(
      auth,
      readOptionalString((body as { officeId?: string }).officeId, 'officeId', 80),
    );
    const monthKey =
      readOptionalString((body as { monthKey?: string }).monthKey, 'monthKey', 7) ??
      scheduleMonthKey();

    let schedule = await dependencies.store.findScheduleForMonth({
      organizationId,
      officeId,
      clientId,
      monthKey,
    });

    if (!schedule) {
      const reviewToken = generateContentReviewToken();
      schedule = await dependencies.store.createSchedule({
        organizationId,
        officeId,
        clientId,
        createdBy: auth.actor.userId,
        title: defaultScheduleTitle(monthKey),
        reviewToken,
        reviewUrl: `/internal-preview/${reviewToken}`,
        status: 'ready_for_review',
        reviewStatus: 'ready_for_review',
        scheduledAt: scheduleMonthStart(monthKey),
        expiresAt: contentReviewLinkExpiresAt(90),
      });
    } else if (!schedule.scheduledAt) {
      schedule = await dependencies.store.updateSchedule(organizationId, schedule.id, {
        scheduledAt: scheduleMonthStart(monthKey),
        title: schedule.title.trim() || defaultScheduleTitle(monthKey),
      });
    }

    if (schedule.status === 'draft') {
      schedule = await dependencies.store.updateSchedule(organizationId, schedule.id, {
        status: 'ready_for_review',
        reviewStatus: 'ready_for_review',
      });
    }

    return c.json({ schedule: serializeSchedule(schedule) });
  });

  routes.get('/schedules/:scheduleId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.read');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const schedule = await dependencies.store.getSchedule(organizationId, scheduleId);
    if (!schedule) {
      throw new NotFoundError(
        'CONTENT_SCHEDULE_NOT_FOUND',
        'Schedule was not found.',
      );
    }
    const [assets, comments, activity] = await Promise.all([
      dependencies.store.listAssetsForSchedules(organizationId, [scheduleId]),
      dependencies.store.listComments(organizationId, [scheduleId]),
      dependencies.store.listActivity(organizationId, [scheduleId]),
    ]);
    return c.json({
      schedule: serializeSchedule(schedule),
      assets: assets.map(serializeAsset),
      comments: comments.map(serializeComment),
      activity: activity.map(serializeActivity),
    });
  });

  routes.patch('/schedules/:scheduleId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const body = await readJson(c);
    const schedule = await dependencies.store.updateSchedule(organizationId, scheduleId, {
      title: asOptionalString(body.title),
      subtitle: asNullableString(body.subtitle),
      body: asNullableString(body.body),
      summary: asNullableString(body.summary),
      captions: asNullableString(body.captions),
      notes: asNullableString(body.notes),
      layoutType: asOptionalString(body.layoutType ?? body.layout_type),
      ctaLabel: asNullableString(body.ctaLabel ?? body.cta_label),
      ctaUrl: asNullableString(body.ctaUrl ?? body.cta_url),
      status: asScheduleStatus(body.status),
      reviewStatus: asNullableString(body.reviewStatus ?? body.review_status),
      scheduledAt: body.scheduledAt
        ? new Date(String(body.scheduledAt))
        : body.scheduledAt === null
          ? null
          : undefined,
      expiresAt: body.expiresAt
        ? new Date(String(body.expiresAt))
        : body.expiresAt === null
          ? null
          : undefined,
      clientId: body.clientId === null
        ? null
        : body.clientId
          ? requireUuidValue(String(body.clientId), 'clientId')
          : undefined,
      assignedTo: body.assignedTo === null
        ? null
        : body.assignedTo
          ? requireUuidValue(String(body.assignedTo), 'assignedTo')
          : undefined,
    });
    return c.json({ schedule: serializeSchedule(schedule) });
  });

  routes.post('/schedules/:scheduleId/archive', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const schedule = await dependencies.store.updateSchedule(organizationId, scheduleId, {
      status: 'archived',
      reviewStatus: 'archived',
    });
    return c.json({ schedule: serializeSchedule(schedule) });
  });

  routes.delete('/schedules/:scheduleId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const assets = await dependencies.store.listAssetsForSchedules(
      organizationId,
      [scheduleId],
    );

    await dependencies.store.deleteSchedule(organizationId, scheduleId);

    for (const asset of assets) {
      if (!asset.storagePath || asset.libraryMediaId) continue;
      const [assetRefs, libraryRefs] = await Promise.all([
        dependencies.store.countAssetsUsingStoragePath(
          organizationId,
          asset.storagePath,
        ),
        dependencies.store.countClientMediaUsingPath(
          organizationId,
          asset.storagePath,
        ),
      ]);
      if (assetRefs === 0 && libraryRefs === 0) {
        await dependencies.files
          .deleteObject(asset.bucket, asset.storagePath)
          .catch((err) => logger.error({ err, organizationId }, 'Content media deletion requires reconciliation'));
      }
    }

    return c.json({ ok: true });
  });

  routes.get('/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.read');
    const raw = c.req.query('scheduleIds') ?? c.req.query('draftIds') ?? '';
    const scheduleIds = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => requireUuidValue(value, 'scheduleId'));
    const assets = await dependencies.store.listAssetsForSchedules(
      organizationId,
      scheduleIds,
    );
    return c.json({ assets: assets.map(serializeAsset) });
  });

  /**
   * Original-quality binary upload (no Base64, no compression/transcode).
   * Streams the request body straight into MinIO. Prefer this for video.
   */
  routes.post('/schedules/:scheduleId/assets/binary', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const schedule = await dependencies.store.getSchedule(organizationId, scheduleId);
    if (!schedule) {
      throw new NotFoundError(
        'CONTENT_SCHEDULE_NOT_FOUND',
        'Schedule was not found.',
      );
    }

    const sizeBytes = requireBinaryUploadSize(c);
    const filename = decodeUploadFilename(
      c.req.query('filename') ?? c.req.header('x-kode-filename') ?? undefined,
    );
    const contentType =
      readOptionalString(
        c.req.header('content-type') ?? c.req.header('x-kode-content-type'),
        'contentType',
        FIELD_LIMITS.contentType,
      ) ?? 'application/octet-stream';
    const displaySlot =
      Number(c.req.query('displaySlot') ?? c.req.header('x-kode-display-slot') ?? 0) || 0;
    const caption = readOptionalString(
      c.req.query('caption') ?? c.req.header('x-kode-caption'),
      'caption',
      FIELD_LIMITS.cardDescription,
    );
    const heading = readOptionalString(
      c.req.query('heading') ?? c.req.header('x-kode-heading'),
      'heading',
      300,
    );

    const uploadBody = c.req.raw.body;
    if (!uploadBody) {
      throw new ValidationError('Request body is required.', { field: 'body' });
    }

    await dependencies.files.ensureBucket?.(CONTENT_REVIEW_ASSETS_BUCKET);
    const fileId = randomUUID();
    const objectKey = contentScheduleObjectKey({
      organizationId,
      scheduleId,
      fileId,
      filename,
    });

    return persistMediaUpload({ organizationId, objectKey, files: dependencies.files, store: dependencies.store }, async () => {

      const put =
        dependencies.files.putObjectStream?.bind(dependencies.files) ??
        (async (input: {
          bucket: string;
          objectKey: string;
          body: ReadableStream<Uint8Array> | Buffer;
          contentType?: string | null;
          contentLength: number;
        }) => {
          const chunks: Uint8Array[] = [];
          if (Buffer.isBuffer(input.body)) {
            chunks.push(input.body);
          } else {
            const reader = input.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
          }
          await dependencies.files.putObject({
            bucket: input.bucket,
            objectKey: input.objectKey,
            body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
            contentType: input.contentType,
          });
        });

      await put({
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        objectKey,
        body: uploadBody,
        contentType,
        contentLength: sizeBytes,
      });

      const assetType = contentAssetTypeFromMime(contentType);
      const asset = await dependencies.store.createUploadedAsset({
        scheduleId,
        organizationId,
        officeId: schedule.officeId,
        uploadedBy: auth.actor.userId,
        fileName: filename,
        fileUrl: mediaProxyUrl(objectKey),
        storagePath: objectKey,
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        mimeType: contentType,
        assetType,
        heading: heading ?? null,
        caption: caption ?? null,
        displaySlot,
        sortOrder: displaySlot,
        originalSizeBytes: sizeBytes,
        storedSizeBytes: sizeBytes,
        compressionStatus: 'stored_original',
        webPlaybackStatus: null,
        expiresAt: CONTENT_ASSET_KEEP_UNTIL,
      }, schedule.clientId);

      return c.json({ asset: serializeAsset(asset) }, 201);
    });
  });

  routes.post('/schedules/:scheduleId/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const schedule = await dependencies.store.getSchedule(organizationId, scheduleId);
    if (!schedule) {
      throw new NotFoundError(
        'CONTENT_SCHEDULE_NOT_FOUND',
        'Schedule was not found.',
      );
    }

    const body = await readJson(c);
    const filename = readRequiredText(
      body.filename ?? body.fileName ?? body.file_name,
      'filename',
      FIELD_LIMITS.filename,
    );
    const contentType =
      readOptionalString(
        body.contentType ?? body.mimeType ?? body.mime_type,
        'contentType',
        FIELD_LIMITS.contentType,
      ) ?? 'application/octet-stream';
    const content = decodeStrictBase64(
      body.contentBase64 ?? body.content,
      'contentBase64',
      c.get('limits').maxAttachmentBytes,
    );

    await dependencies.files.ensureBucket?.(CONTENT_REVIEW_ASSETS_BUCKET);
    const fileId = randomUUID();
    const objectKey = contentScheduleObjectKey({
      organizationId,
      scheduleId,
      fileId,
      filename,
    });

    return persistMediaUpload({ organizationId, objectKey, files: dependencies.files, store: dependencies.store }, async () => {
      await dependencies.files.putObject({
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        objectKey,
        body: content,
        contentType,
      });

      const assetType = contentAssetTypeFromMime(contentType);
      const displaySlot = Number(body.displaySlot ?? body.display_slot ?? 0) || 0;
      const asset = await dependencies.store.createUploadedAsset({
        scheduleId,
        organizationId,
        officeId: schedule.officeId,
        uploadedBy: auth.actor.userId,
        fileName: filename,
        fileUrl: mediaProxyUrl(objectKey),
        storagePath: objectKey,
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        mimeType: contentType,
        assetType,
        heading: readOptionalString(body.heading, 'heading', 300),
        caption: readOptionalString(body.caption, 'caption', FIELD_LIMITS.cardDescription),
        displaySlot,
        sortOrder: Number(body.sortOrder ?? body.sort_order ?? displaySlot) || displaySlot,
        originalSizeBytes: content.byteLength,
        storedSizeBytes: content.byteLength,
        compressionStatus: 'stored_original',
        webPlaybackStatus: null,
        expiresAt: CONTENT_ASSET_KEEP_UNTIL,
      }, schedule.clientId);

      return c.json({ asset: serializeAsset(asset) }, 201);
    });
  });

  routes.patch('/assets/:assetId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const body = await readJson(c);
    const asset = await dependencies.store.updateAsset(organizationId, assetId, {
      heading: asNullableString(body.heading),
      caption: asNullableString(body.caption),
      isSelected: asOptionalBoolean(body.isSelected ?? body.is_selected),
      cropX: asNullableNumber(body.cropX ?? body.crop_x),
      cropY: asNullableNumber(body.cropY ?? body.crop_y),
      cropZoom: asNullableNumber(body.cropZoom ?? body.crop_zoom),
      sortOrder: asOptionalNumber(body.sortOrder ?? body.sort_order),
      displaySlot: asOptionalNumber(body.displaySlot ?? body.display_slot),
    });
    return c.json({ asset: serializeAsset(asset) });
  });

  routes.post('/assets/selection', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const body = await readJson(c);
    const assetIds = Array.isArray(body.assetIds)
      ? body.assetIds.map((id: unknown) => requireUuidValue(String(id), 'assetId'))
      : [];
    await dependencies.store.setAssetsSelected(
      organizationId,
      assetIds,
      Boolean(body.isSelected ?? body.is_selected),
    );
    return c.json({ ok: true });
  });

  routes.delete('/assets/:assetId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const asset = await dependencies.store.deleteAsset(organizationId, assetId);
    if (asset.storagePath && !asset.libraryMediaId) {
      const [assetRefs, libraryRefs] = await Promise.all([
        dependencies.store.countAssetsUsingStoragePath(
          organizationId,
          asset.storagePath,
        ),
        dependencies.store.countClientMediaUsingPath(
          organizationId,
          asset.storagePath,
        ),
      ]);
      if (assetRefs === 0 && libraryRefs === 0) {
        await dependencies.files
          .deleteObject(asset.bucket, asset.storagePath)
          .catch((err) => logger.error({ err, organizationId }, 'Content media deletion requires reconciliation'));
      }
    }
    return c.json({ ok: true, asset: serializeAsset(asset) });
  });

  routes.post('/schedules/:scheduleId/attach-media', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const body = await readJson(c);
    const mediaId = requireUuidValue(
      String(body.mediaId ?? body.libraryMediaId),
      'mediaId',
    );
    const schedule = await dependencies.store.getSchedule(organizationId, scheduleId);
    if (!schedule) {
      throw new NotFoundError(
        'CONTENT_SCHEDULE_NOT_FOUND',
        'Schedule was not found.',
      );
    }
    const media = await dependencies.store.getClientMedia(organizationId, mediaId);
    if (!media) {
      throw new NotFoundError('CONTENT_MEDIA_NOT_FOUND', 'Media was not found.');
    }
    const displaySlot = Number(body.displaySlot ?? body.display_slot ?? 0) || 0;
    const asset = await dependencies.store.createAsset({
      scheduleId,
      organizationId,
      officeId: schedule.officeId,
      libraryMediaId: media.id,
      uploadedBy: auth.actor.userId,
      fileName: media.fileName,
      fileUrl: media.fileUrl,
      storagePath: media.storagePath ?? '',
      bucket: media.bucket,
      mimeType: media.mimeType,
      assetType: media.assetType,
      displaySlot,
      sortOrder: displaySlot,
      originalSizeBytes: media.originalSizeBytes,
      storedSizeBytes: media.storedSizeBytes,
      compressionStatus: media.compressionStatus,
      webPlaybackStatus: media.webPlaybackStatus,
      expiresAt: media.expiresAt ?? CONTENT_ASSET_KEEP_UNTIL,
    });
    return c.json({ asset: serializeAsset(asset) }, 201);
  });

  routes.get('/clients/:clientId/media', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.read');
    const clientId = requireUuidValue(c.req.param('clientId'), 'clientId');
    const media = await dependencies.store.listClientMedia(
      organizationId,
      clientId,
      readListQuery(c),
    );
    return c.json({
      media: media.media.map(serializeMedia),
      hasMore: media.hasMore,
    });
  });

  routes.post('/clients/:clientId/media/binary', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const clientId = requireUuidValue(c.req.param('clientId'), 'clientId');
    const officeId = requireOfficeId(
      auth,
      c.req.query('officeId') ?? c.req.header('x-kode-office-id'),
    );
    const client = await dependencies.store.getClient(
      organizationId,
      officeId,
      clientId,
    );
    if (!client) {
      throw new NotFoundError('CONTENT_CLIENT_NOT_FOUND', 'Client was not found.');
    }

    const sizeBytes = requireBinaryUploadSize(c);
    const filename = decodeUploadFilename(
      c.req.query('filename') ?? c.req.header('x-kode-filename') ?? undefined,
    );
    const contentType =
      readOptionalString(
        c.req.header('content-type') ?? c.req.header('x-kode-content-type'),
        'contentType',
        FIELD_LIMITS.contentType,
      ) ?? 'application/octet-stream';
    const label = readOptionalString(
      c.req.query('label') ?? c.req.header('x-kode-label'),
      'label',
      200,
    );

    const uploadBody = c.req.raw.body;
    if (!uploadBody) {
      throw new ValidationError('Request body is required.', { field: 'body' });
    }

    await dependencies.files.ensureBucket?.(CONTENT_REVIEW_ASSETS_BUCKET);
    const fileId = randomUUID();
    const objectKey = contentClientObjectKey({
      organizationId,
      clientId,
      fileId,
      filename,
    });

    return persistMediaUpload({ organizationId, objectKey, files: dependencies.files, store: dependencies.store }, async () => {

      const put =
        dependencies.files.putObjectStream?.bind(dependencies.files) ??
        (async (input: {
          bucket: string;
          objectKey: string;
          body: ReadableStream<Uint8Array> | Buffer;
          contentType?: string | null;
          contentLength: number;
        }) => {
          const chunks: Uint8Array[] = [];
          if (Buffer.isBuffer(input.body)) {
            chunks.push(input.body);
          } else {
            const reader = input.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
          }
          await dependencies.files.putObject({
            bucket: input.bucket,
            objectKey: input.objectKey,
            body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
            contentType: input.contentType,
          });
        });

      await put({
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        objectKey,
        body: uploadBody,
        contentType,
        contentLength: sizeBytes,
      });

      const assetType = contentAssetTypeFromMime(contentType);
      const media = await dependencies.store.createClientMedia({
        clientId,
        organizationId,
        officeId,
        uploadedBy: auth.actor.userId,
        fileName: filename,
        fileUrl: mediaProxyUrl(objectKey),
        storagePath: objectKey,
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        mimeType: contentType,
        assetType,
        label: label ?? null,
        originalSizeBytes: sizeBytes,
        storedSizeBytes: sizeBytes,
        compressionStatus: 'stored_original',
        webPlaybackStatus: null,
        expiresAt: CONTENT_ASSET_KEEP_UNTIL,
      });

      return c.json({ media: serializeMedia(media) }, 201);
    });
  });

  routes.post('/clients/:clientId/media', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const clientId = requireUuidValue(c.req.param('clientId'), 'clientId');
    const body = await readJson(c);
    const officeId = requireOfficeId(
      auth,
      readOptionalString(body.officeId, 'officeId', 80),
    );
    const client = await dependencies.store.getClient(
      organizationId,
      officeId,
      clientId,
    );
    if (!client) {
      throw new NotFoundError('CONTENT_CLIENT_NOT_FOUND', 'Client was not found.');
    }

    const filename = readRequiredText(
      body.filename ?? body.fileName ?? body.file_name,
      'filename',
      FIELD_LIMITS.filename,
    );
    const contentType =
      readOptionalString(
        body.contentType ?? body.mimeType ?? body.mime_type,
        'contentType',
        FIELD_LIMITS.contentType,
      ) ?? 'application/octet-stream';
    const content = decodeStrictBase64(
      body.contentBase64 ?? body.content,
      'contentBase64',
      c.get('limits').maxAttachmentBytes,
    );

    await dependencies.files.ensureBucket?.(CONTENT_REVIEW_ASSETS_BUCKET);
    const fileId = randomUUID();
    const objectKey = contentClientObjectKey({
      organizationId,
      clientId,
      fileId,
      filename,
    });

    return persistMediaUpload({ organizationId, objectKey, files: dependencies.files, store: dependencies.store }, async () => {
      await dependencies.files.putObject({
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        objectKey,
        body: content,
        contentType,
      });

      const assetType = contentAssetTypeFromMime(contentType);
      const media = await dependencies.store.createClientMedia({
        clientId,
        organizationId,
        officeId,
        uploadedBy: auth.actor.userId,
        fileName: filename,
        fileUrl: mediaProxyUrl(objectKey),
        storagePath: objectKey,
        bucket: CONTENT_REVIEW_ASSETS_BUCKET,
        mimeType: contentType,
        assetType,
        label: readOptionalString(body.label, 'label', 200),
        originalSizeBytes: content.byteLength,
        storedSizeBytes: content.byteLength,
        compressionStatus: 'stored_original',
        webPlaybackStatus: null,
        expiresAt: CONTENT_ASSET_KEEP_UNTIL,
      });

      return c.json({ media: serializeMedia(media) }, 201);
    });
  });

  routes.delete('/media/:mediaId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const mediaId = requireUuidValue(c.req.param('mediaId'), 'mediaId');
    const refs = await dependencies.store.countLibraryRefs(organizationId, mediaId);
    if (refs > 0) {
      throw new ValidationError(
        'This library file is still attached to a schedule. Detach it first.',
        { field: 'mediaId' },
      );
    }
    const media = await dependencies.store.deleteClientMedia(organizationId, mediaId);
    if (media.storagePath) {
      const remaining = await dependencies.store.countClientMediaUsingPath(
        organizationId,
        media.storagePath,
      );
      const assetRefs = await dependencies.store.countAssetsUsingStoragePath(
        organizationId,
        media.storagePath,
      );
      if (remaining === 0 && assetRefs === 0) {
        await dependencies.files
          .deleteObject(media.bucket, media.storagePath)
          .catch((err) => logger.error({ err, organizationId }, 'Content media deletion requires reconciliation'));
      }
    }
    return c.json({ ok: true });
  });

  routes.post('/media/capability', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.read');
    const body = await readJson(c);
    const objectKey = readMediaObjectKey(String(body.objectKey ?? body.object_key ?? ''));
    if (!objectKey || !dependencies.store.findMediaOwnership ||
        !(await dependencies.store.findMediaOwnership(organizationId, objectKey))) {
      throw new NotFoundError('CONTENT_MEDIA_NOT_FOUND', 'Media was not found.');
    }
    c.header('Cache-Control', 'no-store');
    const capability = await capabilities.issue({ organizationId, objectKey }, 60 * 60 * 1000);
    return c.json({
      url: `/api/content-studio/media?cap=${encodeURIComponent(capability)}`,
      expiresIn: 60 * 60,
    });
  });

  routes.get('/media', async (c) => {
    const capability = (c.req.query('cap') ?? '').trim();
    const granted = capability ? await capabilities.consume(capability) : null;
    if (!granted) {
      throw new ForbiddenError('CONTENT_MEDIA_FORBIDDEN', 'Media capability is invalid or expired.');
    }
    if (!dependencies.store.findMediaOwnership ||
        !(await dependencies.store.findMediaOwnership(granted.organizationId, granted.objectKey))) {
      throw new NotFoundError('CONTENT_MEDIA_NOT_FOUND', 'Media was not found.');
    }
    return streamStoredMedia({
      files: dependencies.files,
      bucket: CONTENT_REVIEW_ASSETS_BUCKET,
      objectKey: granted.objectKey,
      rangeHeader: c.req.header("range"),
      cacheControl: "private, no-store",
    });
  });

  routes.post('/internal-reviews/:token/feedback', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const schedule = await dependencies.store.getScheduleByReviewToken(c.req.param('token'));
    if (!schedule || schedule.organizationId !== organizationId) {
      throw new NotFoundError('CONTENT_SCHEDULE_NOT_FOUND', 'Schedule was not found.');
    }
    await assertContentStudioOffice({ directory: dependencies.directory, organizationId, officeId: schedule.officeId });
    const body = await readJson(c);
    const result = await submitInternalReview({
      store: dependencies.store, organizationId, scheduleId: schedule.id, auth,
      slot: typeof body.slot === 'number' ? body.slot : NaN, decision: readRequiredText(body.decision, 'decision', 40),
      message: readRequiredText(body.message, 'message', FIELD_LIMITS.commentBody),
    });
    return c.json(result.ok ? { ...result, comment: serializeComment(result.comment) } : result);
  });

  routes.post('/schedules/:scheduleId/comments', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const schedule = await dependencies.store.getSchedule(organizationId, scheduleId);
    if (!schedule) {
      throw new NotFoundError(
        'CONTENT_SCHEDULE_NOT_FOUND',
        'Schedule was not found.',
      );
    }
    const body = await readJson(c);
    const comment = await dependencies.store.addComment({
      scheduleId,
      organizationId,
      officeId: schedule.officeId,
      authorName: readRequiredText(
        body.authorName ?? auth.actor.email ?? 'Content Studio',
        'authorName',
        200,
      ),
      authorEmail: readOptionalString(body.authorEmail, 'authorEmail', 320),
      body: readRequiredText(body.body ?? body.comment, 'body', FIELD_LIMITS.cardDescription),
      createdBy: auth.actor.userId,
      displaySlot: asNullableNumber(body.displaySlot ?? body.display_slot) ?? null,
    });
    return c.json({ comment: serializeComment(comment) }, 201);
  });

  routes.post('/schedules/:scheduleId/activity', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.manage');
    const scheduleId = requireUuidValue(c.req.param('scheduleId'), 'scheduleId');
    const schedule = await dependencies.store.getSchedule(organizationId, scheduleId);
    if (!schedule) {
      throw new NotFoundError(
        'CONTENT_SCHEDULE_NOT_FOUND',
        'Schedule was not found.',
      );
    }
    const body = await readJson(c);
    const activityType = readRequiredText(
      body.activityType ?? body.type ?? body.activity_type,
      'activityType',
      120,
    );
    await dependencies.store.recordActivity({
      scheduleId,
      organizationId,
      officeId: schedule.officeId,
      actorUserId: auth.actor.userId,
      activityType,
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : {},
    });
    return c.json({ ok: true }, 201);
  });

  routes.get('/comments', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeContent(auth, 'content_studio.read');
    const scheduleIdsRaw = c.req.query('scheduleIds') ?? '';
    const scheduleIds = scheduleIdsRaw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => isUuid(id));
    const comments = await dependencies.store.listComments(
      organizationId,
      scheduleIds,
    );
    return c.json({ comments: comments.map(serializeComment) });
  });

  return routes;
}
