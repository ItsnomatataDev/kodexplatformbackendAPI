import { Hono, type Context } from 'hono';
import { assertAuthorized } from '../../authorization/authorize.js';
import { requireOrganizationId } from '../../authorization/organization.js';
import { getAuth } from '../../auth/middleware.js';
import { enforceRateLimit } from '../../auth/rate-limit.js';
import { ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../http/errors.js';
import { FIELD_LIMITS } from '../../http/limits.js';
import {
  readJson,
  readOptionalInteger,
  readOptionalString,
  readRequiredText,
  rejectIdentityOverrides,
  requireUuidValue,
} from '../../work/http.js';
import type { OrganizationDirectoryStore } from '../../organizations/store.js';
import type { ContentStore, ContentScheduleAssetRecord, ContentClientMediaRecord } from '../store.js';
import type { UploadSessionRepository } from './types.js';
import { ResumableUploadService, type CreateResumableUploadInput } from './service.js';
import { logger } from '../../config/logger.js';

type Serializable<T> = {
  [Key in keyof T]: T[Key] extends Date
    ? string
    : T[Key] extends Date | null
      ? string | null
      : T[Key];
};

function authorizedOrganization(auth: ReturnType<typeof getAuth>) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action: 'content_studio.manage',
    resource: { type: 'content_studio', organizationId },
  });
  return organizationId;
}

function currentOfficeId(auth: ReturnType<typeof getAuth>, raw?: string | null) {
  const officeId = (raw ?? auth.membership.officeId ?? '').trim();
  if (!officeId) {
    throw new ValidationError('Your profile must be assigned to a Content Studio office.', {
      field: 'officeId',
    });
  }
  return officeId;
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function serializeAsset(row: ContentScheduleAssetRecord | Serializable<ContentScheduleAssetRecord>) {
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

function serializeMedia(row: ContentClientMediaRecord | Serializable<ContentClientMediaRecord>) {
  return {
    id: row.id,
    clientId: row.clientId,
    organizationId: row.organizationId,
    officeId: row.officeId,
    uploadedBy: row.uploadedBy,
    fileName: row.fileName,
    fileUrl: row.fileUrl,
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

function serializeResult(result: Record<string, unknown> | null) {
  if (!result) return null;
  if ('asset' in result && result.asset && typeof result.asset === 'object') {
    return {
      asset: serializeAsset(result.asset as Serializable<ContentScheduleAssetRecord>),
    };
  }
  if ('media' in result && result.media && typeof result.media === 'object') {
    return {
      media: serializeMedia(result.media as Serializable<ContentClientMediaRecord>),
    };
  }
  return result;
}

export function createResumableUploadRoutes(dependencies: {
  service: ResumableUploadService;
  repository: UploadSessionRepository;
  content: ContentStore;
  directory: OrganizationDirectoryStore;
}) {
  const routes = new Hono();

  async function requireCurrentTarget(auth: ReturnType<typeof getAuth>, sessionId: string) {
    const organizationId = authorizedOrganization(auth);
    const session = await dependencies.repository.getOwned(
      organizationId,
      auth.actor.userId,
      sessionId,
    );
    if (!session) throw new NotFoundError('UPLOAD_SESSION_NOT_FOUND');
    const office = await dependencies.directory.getOffice(organizationId, session.target.officeId);
    if (!office) throw new NotFoundError('OFFICE_NOT_FOUND', 'Office was not found.');
    if ((office.slug ?? '').toLowerCase() === 'three-little-birds') {
      throw new ForbiddenError(
        'CONTENT_STUDIO_OFFICE_BLOCKED',
        'Content Studio is not available for this office.',
      );
    }
    if (session.target.type === 'schedule_asset') {
      const schedule = await dependencies.content.getSchedule(organizationId, session.target.scheduleId);
      if (
        !schedule ||
        schedule.officeId !== session.target.officeId ||
        schedule.clientId !== session.target.clientId
      ) {
        throw new NotFoundError('CONTENT_SCHEDULE_NOT_FOUND', 'Schedule was not found.');
      }
    } else {
      const client = await dependencies.content.getClient(
        organizationId,
        session.target.officeId,
        session.target.clientId,
      );
      if (!client) throw new NotFoundError('CONTENT_CLIENT_NOT_FOUND', 'Client was not found.');
    }
    return { organizationId, session };
  }

  async function rateLimit(c: Context, kind: 'uploadSession' | 'uploadPart') {
    const limiter = c.get('rateLimiter');
    if (!limiter) {
      throw new ServiceUnavailableError(
        'RATE_LIMIT_UNAVAILABLE',
        'Rate limiting is temporarily unavailable.',
      );
    }
    const policy = c.get('rateLimitPolicies')[kind];
    const auth = getAuth(c);
    const organizationId = requireOrganizationId(auth);
    await enforceRateLimit(
      limiter,
      `content-upload:${kind}:user:${organizationId}:${auth.actor.userId}`,
      policy.limit,
      policy.windowSeconds,
    );
    if (kind === 'uploadPart') {
      await enforceRateLimit(
        limiter,
        `content-upload:${kind}:org:${organizationId}`,
        policy.limit * 8,
        policy.windowSeconds,
      );
    }
  }

  routes.post('/sessions', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizedOrganization(auth);
    await rateLimit(c, 'uploadSession');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const scheduleId = body.scheduleId === undefined
      ? null
      : requireUuidValue(body.scheduleId, 'scheduleId');
    const clientId = body.clientId === undefined
      ? null
      : requireUuidValue(body.clientId, 'clientId');
    if (Boolean(scheduleId) === Boolean(clientId)) {
      throw new ValidationError('Provide exactly one of scheduleId or clientId.');
    }
    const filename = readRequiredText(
      body.filename,
      'filename',
      FIELD_LIMITS.filename,
    );
    const mimeType = readRequiredText(
      body.mimeType,
      'mimeType',
      FIELD_LIMITS.contentType,
    ).toLowerCase();
    if (typeof body.fileSizeBytes !== 'number' || !Number.isSafeInteger(body.fileSizeBytes)) {
      throw new ValidationError('fileSizeBytes must be a positive integer.', {
        field: 'fileSizeBytes',
      });
    }
    let resolvedTarget: CreateResumableUploadInput['target'];
    if (scheduleId) {
      const schedule = await dependencies.content.getSchedule(organizationId, scheduleId);
      if (!schedule) {
        throw new NotFoundError('CONTENT_SCHEDULE_NOT_FOUND', 'Schedule was not found.');
      }
      const office = await dependencies.directory.getOffice(organizationId, schedule.officeId);
      if (!office) throw new NotFoundError('OFFICE_NOT_FOUND', 'Office was not found.');
      if ((office.slug ?? '').toLowerCase() === 'three-little-birds') {
        throw new ForbiddenError(
          'CONTENT_STUDIO_OFFICE_BLOCKED',
          'Content Studio is not available for this office.',
        );
      }
      resolvedTarget = {
        type: 'schedule_asset',
        scheduleId,
        clientId: schedule.clientId,
        officeId: schedule.officeId,
        displaySlot: readOptionalInteger(body.displaySlot, 'displaySlot') ?? 0,
        heading: readOptionalString(body.heading, 'heading', 300) ?? null,
        caption: readOptionalString(body.caption, 'caption', FIELD_LIMITS.cardDescription) ?? null,
      };
      if (resolvedTarget.displaySlot < 0 || resolvedTarget.displaySlot > 10_000) {
        throw new ValidationError('displaySlot must be between 0 and 10000.', {
          field: 'displaySlot',
        });
      }
    } else {
      const officeId = currentOfficeId(auth, readOptionalString(body.officeId, 'officeId', 100));
      const office = await dependencies.directory.getOffice(organizationId, officeId);
      if (!office) throw new NotFoundError('OFFICE_NOT_FOUND', 'Office was not found.');
      if ((office.slug ?? '').toLowerCase() === 'three-little-birds') {
        throw new ForbiddenError(
          'CONTENT_STUDIO_OFFICE_BLOCKED',
          'Content Studio is not available for this office.',
        );
      }
      const client = await dependencies.content.getClient(organizationId, officeId, clientId!);
      if (!client) throw new NotFoundError('CONTENT_CLIENT_NOT_FOUND', 'Client was not found.');
      resolvedTarget = {
        type: 'client_media',
        clientId: client.id,
        officeId,
        label: readOptionalString(body.label, 'label', 200) ?? null,
      };
    }

    const session = await dependencies.service.create({
      organizationId,
      createdBy: auth.actor.userId,
      target: resolvedTarget,
      originalFilename: filename,
      mimeType,
      expectedSizeBytes: body.fileSizeBytes,
    });
    logger.info(
      {
        organizationId,
        userId: auth.actor.userId,
        sessionId: session.sessionId,
        targetType: session.targetType,
        fileSizeBytes: session.fileSizeBytes,
      },
      'content_studio_upload_session_created',
    );
    return c.json({ session }, session.state === 'initiating' ? 202 : 201);
  });

  routes.get('/sessions/:sessionId', async (c) => {
    const auth = getAuth(c);
    const { organizationId } = await requireCurrentTarget(
      auth,
      requireUuidValue(c.req.param('sessionId'), 'sessionId'),
    );
    const session = await dependencies.service.get(
      organizationId,
      auth.actor.userId,
      c.req.param('sessionId'),
    );
    return c.json({ session });
  });

  routes.get('/sessions/:sessionId/parts', async (c) => {
    const auth = getAuth(c);
    const { organizationId } = await requireCurrentTarget(
      auth,
      requireUuidValue(c.req.param('sessionId'), 'sessionId'),
    );
    const session = await dependencies.service.get(
      organizationId,
      auth.actor.userId,
      c.req.param('sessionId'),
    );
    return c.json({ parts: session.committedParts });
  });

  routes.put('/sessions/:sessionId/parts/:partNumber', async (c) => {
    const auth = getAuth(c);
    const sessionId = requireUuidValue(c.req.param('sessionId'), 'sessionId');
    const { organizationId } = await requireCurrentTarget(auth, sessionId);
    await rateLimit(c, 'uploadPart');
    const contentLength = Number(c.req.header('content-length'));
    const body = c.req.raw.body;
    if (!body) throw new ValidationError('Request body is required.', { field: 'body' });
    const result = await dependencies.service.uploadPart(
      organizationId,
      auth.actor.userId,
      sessionId,
      Number(c.req.param('partNumber')),
      contentLength,
      body,
    );
    return c.json({ part: result });
  });

  routes.post('/sessions/:sessionId/complete', async (c) => {
    const auth = getAuth(c);
    const sessionId = requireUuidValue(c.req.param('sessionId'), 'sessionId');
    const { organizationId } = await requireCurrentTarget(auth, sessionId);
    await rateLimit(c, 'uploadSession');
    const completed = await dependencies.service.complete(
      organizationId,
      auth.actor.userId,
      sessionId,
    );
    const result = serializeResult(completed.result);
    logger.info(
      { organizationId, userId: auth.actor.userId, sessionId },
      'content_studio_upload_completed',
    );
    return c.json({ session: completed.session, ...(result ?? {}) });
  });

  routes.delete('/sessions/:sessionId', async (c) => {
    const auth = getAuth(c);
    const sessionId = requireUuidValue(c.req.param('sessionId'), 'sessionId');
    const { organizationId } = await requireCurrentTarget(auth, sessionId);
    await rateLimit(c, 'uploadSession');
    const result = await dependencies.service.cancel(
      organizationId,
      auth.actor.userId,
      sessionId,
    );
    logger.info(
      { organizationId, userId: auth.actor.userId, sessionId },
      'content_studio_upload_cancelled',
    );
    return c.json(result);
  });

  return routes;
}
