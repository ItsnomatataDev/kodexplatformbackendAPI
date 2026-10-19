import { internalFeedbackState } from '../content/portal.js';
import { Hono } from 'hono';
import { NotFoundError, ValidationError } from '../http/errors.js';
import type { FileStorage } from '../files/storage.js';
import type { ContentStore } from '../content/store.js';
import { CONTENT_REVIEW_ASSETS_BUCKET } from '../content/buckets.js';
import { streamStoredMedia } from '../content/media-stream.js';
import type {
  ContentCommentRecord,
  ContentScheduleAssetRecord,
  ContentScheduleRecord,
} from '../content/store.js';

export type ContentPreviewRouteDependencies = {
  store: ContentStore;
  files: FileStorage;
};

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function readObjectKey(raw: string | undefined | null) {
  // Hono has already decoded the query once. Never trim or decode the key
  // used for exact asset membership and storage lookup.
  const value = raw ?? '';
  const unsafe = (key: string) =>
    !key || key.startsWith('/') || /[\\\x00-\x1f\x7f-\x9f]/.test(key) ||
    key.split('/').some((segment) => segment === '.' || segment === '..');
  if (unsafe(value)) return '';
  if (value.includes('%')) {
    try {
      // Inspect residual encoding only; do not turn a literal %XX filename
      // into a different object key. Hono tolerates malformed escapes.
      if (unsafe(decodeURIComponent(value))) return '';
    } catch {
      return '';
    }
  }
  return value;
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
    fileUrl: row.fileUrl,
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
    source: row.source,
    visibility: row.visibility,
    authorType: row.authorType,
    commentType: row.commentType,
    displaySlot: row.displaySlot,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  };
}

export function createContentPreviewRoutes(
  dependencies: ContentPreviewRouteDependencies,
) {
  const routes = new Hono();

  routes.get('/media', async (c) => {
    const reviewToken = (c.req.query('reviewToken') ?? c.req.query('review_token') ?? '').trim();
    const objectKey = readObjectKey(c.req.query('objectKey') ?? c.req.query('object_key'));
    if (!reviewToken || !objectKey) {
      throw new ValidationError('Missing preview media parameters.');
    }

    const schedule = await dependencies.store.getScheduleByReviewToken(reviewToken);
    if (!schedule || (schedule.expiresAt && schedule.expiresAt.getTime() < Date.now())) {
      throw new NotFoundError('CONTENT_PREVIEW_NOT_FOUND', 'Preview link was not found.');
    }
    if (!objectKey.startsWith(`${schedule.organizationId}/`)) {
      throw new NotFoundError('CONTENT_MEDIA_NOT_FOUND', 'Media was not found.');
    }

    const assets = await dependencies.store.listAssetsForSchedules(
      schedule.organizationId,
      [schedule.id],
    );
    const allowed = assets.some((asset) => asset.storagePath === objectKey);
    if (!allowed) {
      throw new NotFoundError('CONTENT_MEDIA_NOT_FOUND', 'Media was not found.');
    }

    return streamStoredMedia({
      preferPlayback: true,
      files: dependencies.files,
      bucket: CONTENT_REVIEW_ASSETS_BUCKET,
      objectKey,
      rangeHeader: c.req.header("range"),
      cacheControl: "private, no-store",
    });
  });

  routes.get('/:token', async (c) => {
    const token = c.req.param('token')?.trim();
    if (!token) {
      return c.json({ ok: false, error: 'not_found' });
    }

    const schedule = await dependencies.store.getScheduleByReviewToken(token);
    if (!schedule) {
      return c.json({ ok: false, error: 'not_found' });
    }
    if (schedule.expiresAt && schedule.expiresAt.getTime() < Date.now()) {
      return c.json({ ok: false, error: 'expired' });
    }

    const [assets, comments] = await Promise.all([
      dependencies.store.listAssetsForSchedules(schedule.organizationId, [schedule.id]),
      dependencies.store.listComments(schedule.organizationId, [schedule.id]),
    ]);

    return c.json({
      ok: true,
      preview_mode: 'internal',
      draft: serializeSchedule(schedule),
      assets: assets.map(serializeAsset),
      comments: comments.map(serializeComment),
      feedback: internalFeedbackState(assets, comments),
    });
  });

  return routes;
}
