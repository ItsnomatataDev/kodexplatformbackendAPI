import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { env } from '../config/env.js';
import { decodeStrictBase64 } from '../http/base64.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { FIELD_LIMITS } from '../http/limits.js';
import type { FileStorage } from '../files/storage.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import { attachmentDisposition, streamStoredMedia } from '../content/media-stream.js';
import {
  TICKET_PRIORITIES,
  ticketAttachmentObjectKey,
  type TicketPriority,
  type TicketStore,
} from '../tickets/store.js';

export type TicketPortalRouteDependencies = {
  store: TicketStore;
  files: FileStorage;
};

const SHEARWATER_OFFICE_SLUGS = new Set([
  'swtech',
  'shearwater-office',
  'shearwater-tech',
]);

function parsePriority(value: unknown, field: string): TicketPriority {
  if (typeof value !== 'string' || !TICKET_PRIORITIES.includes(value as TicketPriority)) {
    throw new ValidationError(`${field} is not a valid ticket priority.`, { field });
  }
  return value as TicketPriority;
}

function safeFilename(value: string) {
  const trimmed = value.trim();
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const filename = base.length > 0 ? base : 'attachment';
  if (filename.length > FIELD_LIMITS.filename) {
    throw new ValidationError(`filename must be at most ${FIELD_LIMITS.filename} characters.`, {
      field: 'filename',
    });
  }
  return filename;
}

function isAllowedTicketAttachment(contentType: string, filename: string) {
  if (
    contentType.startsWith('image/') ||
    contentType === 'application/pdf' ||
    contentType === 'text/plain'
  ) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp|heic|heif|pdf|txt)$/i.test(filename);
}

function serializePublicTicket(ticket: Awaited<ReturnType<TicketStore['getByTrackingToken']>>) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    organization_id: ticket.organizationId,
    office_id: ticket.officeId,
    ticket_number: ticket.ticketNumber,
    requester_type: ticket.requesterType,
    external_name: ticket.externalName,
    external_company: ticket.externalCompany,
    requester_email: ticket.requesterEmail,
    external_phone: ticket.externalPhone,
    category: ticket.category,
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    action_taken: ticket.actionTaken,
    resolved_at: ticket.resolvedAt?.toISOString() ?? null,
    closed_at: ticket.closedAt?.toISOString() ?? null,
    created_at: ticket.createdAt.toISOString(),
    updated_at: ticket.updatedAt.toISOString(),
    office_name: ticket.officeName,
    organization_name: ticket.organizationName,
  };
}

export function createTicketPortalRoutes(
  dependencies: TicketPortalRouteDependencies,
) {
  const routes = new Hono();

  routes.get('/organizations/:slug', async (c) => {
    const slug = readRequiredText(c.req.param('slug'), 'slug', 120);
    const organization = await dependencies.store.getPublicOrganizationBySlug(slug);
    if (!organization) {
      throw new NotFoundError(
        'ORGANIZATION_NOT_FOUND',
        'The support organization was not found.',
      );
    }
    return c.json({ organization });
  });

  routes.get('/organizations/:organizationId/offices', async (c) => {
    const organizationId = requireUuidValue(
      c.req.param('organizationId'),
      'organizationId',
    );
    const offices = await dependencies.store.listPublicOffices(organizationId);
    return c.json({ offices });
  });

  routes.post('/tickets', async (c) => {
    const body = await readJson(c);
    const organizationId = requireUuidValue(
      body.organizationId ?? body.organization_id,
      'organizationId',
    );
    let officeId =
      typeof (body.officeId ?? body.office_id) === 'string'
        ? requireUuidValue(body.officeId ?? body.office_id, 'officeId')
        : null;
    const offices = await dependencies.store.listPublicOffices(organizationId);
    if (!officeId) {
      const shearwater = offices.find((office) =>
        SHEARWATER_OFFICE_SLUGS.has(String(office.slug ?? '').toLowerCase()),
      );
      officeId = shearwater?.id ?? offices[0]?.id ?? null;
    }
    if (!officeId || !offices.some((office) => office.id === officeId)) {
      throw new ValidationError('A valid requesting office is required.', {
        field: 'officeId',
      });
    }

    const ticket = await dependencies.store.createPublic({
      organizationId,
      officeId,
      externalName: readRequiredText(
        body.fullName ?? body.externalName ?? body.external_name,
        'fullName',
        200,
      ),
      externalCompany: readOptionalString(
        body.company ?? body.externalCompany ?? body.external_company,
        'company',
        200,
      ),
      requesterEmail: readRequiredText(
        body.email ?? body.requesterEmail ?? body.requester_email,
        'email',
        320,
      ).toLowerCase(),
      externalPhone: readOptionalString(
        body.phone ?? body.externalPhone ?? body.external_phone,
        'phone',
        64,
      ),
      category: readRequiredText(body.category, 'category', FIELD_LIMITS.ticketCategory),
      subject: readRequiredText(body.subject, 'subject', FIELD_LIMITS.ticketSubject),
      description: readRequiredText(
        body.description,
        'description',
        FIELD_LIMITS.ticketDescription,
      ),
      priority:
        body.priority === undefined
          ? 'medium'
          : parsePriority(body.priority, 'priority'),
    });

    return c.json(
      {
        id: ticket.id,
        ticket_number: ticket.ticketNumber,
        tracking_token: ticket.trackingToken,
        status: ticket.status,
        priority: ticket.priority,
        office_id: ticket.officeId,
      },
      201,
    );
  });

  routes.get('/tickets/:token', async (c) => {
    const token = requireUuidValue(c.req.param('token'), 'token');
    const ticket = await dependencies.store.getByTrackingToken(token);
    if (!ticket) {
      return c.json({ ticket: null });
    }
    const [comments, attachments, rating] = await Promise.all([
      dependencies.store.listComments(ticket.organizationId, ticket.id),
      dependencies.store.listAttachments(ticket.organizationId, ticket.id),
      dependencies.store.getRating(ticket.organizationId, ticket.id),
    ]);
    return c.json({
      ticket: serializePublicTicket(ticket),
      comments: comments
        .filter((comment) => comment.visibility === 'public')
        .map((comment) => ({
          id: comment.id,
          ticket_id: comment.ticketId,
          organization_id: comment.organizationId,
          author_type: comment.authorType,
          author_id: null,
          external_name: comment.externalName,
          external_email: comment.externalEmail,
          body: comment.body,
          visibility: comment.visibility,
          created_at: comment.createdAt.toISOString(),
          author_name: comment.authorName,
        })),
      history: [],
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        ticket_id: attachment.ticketId,
        comment_id: null,
        organization_id: attachment.organizationId,
        file_name: attachment.originalFilename,
        file_path: `kode:${attachment.ticketId}/${attachment.id}`,
        file_size: attachment.sizeBytes ?? 0,
        mime_type: attachment.contentType ?? 'application/octet-stream',
        scan_status: 'clean',
        created_at: attachment.createdAt.toISOString(),
      })),
      rating: rating
        ? {
            id: rating.id,
            ticket_id: rating.ticketId,
            organization_id: rating.organizationId,
            rating: rating.rating,
            feedback: rating.feedback,
            created_at: rating.createdAt.toISOString(),
          }
        : null,
    });
  });

  routes.post('/tickets/:token/comments', async (c) => {
    const token = requireUuidValue(c.req.param('token'), 'token');
    const body = await readJson(c);
    const comment = await dependencies.store.createPublicComment({
      trackingToken: token,
      body: readRequiredText(body.body, 'body', FIELD_LIMITS.ticketCommentBody),
      requesterName: readOptionalString(
        body.name ?? body.requesterName ?? body.requester_name,
        'name',
        200,
      ),
      requesterEmail: readOptionalString(
        body.email ?? body.requesterEmail ?? body.requester_email,
        'email',
        320,
      ),
    });
    if (!comment) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'Ticket not found.');
    }
    return c.json({ id: comment.id }, 201);
  });

  routes.get('/tickets/:token/attachments/:attachmentId/content', async (c) => {
    const token = requireUuidValue(c.req.param('token'), 'token');
    const attachmentId = requireUuidValue(c.req.param('attachmentId'), 'attachmentId');
    const ticket = await dependencies.store.getByTrackingToken(token);
    if (!ticket) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'Ticket not found.');
    }
    const attachment = await dependencies.store.getAttachmentById(
      ticket.organizationId,
      attachmentId,
    );
    if (!attachment || attachment.ticketId !== ticket.id) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    return streamStoredMedia({
      files: dependencies.files,
      bucket: attachment.bucket,
      objectKey: attachment.objectKey,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, no-store',
      contentType: attachment.contentType,
      contentDisposition: attachmentDisposition('inline', attachment.originalFilename),
      notFoundCode: 'ATTACHMENT_NOT_FOUND',
      notFoundMessage: 'The attachment was not found.',
    });
  });

  routes.post('/tickets/:token/attachments', async (c) => {
    const token = requireUuidValue(c.req.param('token'), 'token');
    const ticket = await dependencies.store.getByTrackingToken(token);
    if (!ticket) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'Ticket not found.');
    }
    const body = await readJson(c);
    const filename = safeFilename(
      readRequiredText(body.filename ?? body.fileName ?? body.file_name, 'filename', 255),
    );
    const contentType =
      readOptionalString(body.contentType ?? body.content_type ?? body.mime_type, 'contentType', 200) ??
      'application/octet-stream';
    if (!isAllowedTicketAttachment(contentType, filename)) {
      throw new ValidationError('That file type is not allowed.', {
        field: 'contentType',
      });
    }
    const contentBase64 = body.contentBase64 ?? body.content_base64;
    const bytes = decodeStrictBase64(
      contentBase64,
      'contentBase64',
      env.limits.maxAttachmentBytes,
    );
    if (bytes.byteLength <= 0) {
      throw new ValidationError('Choose a file that is not empty.', {
        field: 'contentBase64',
      });
    }
    const attachmentId = randomUUID();
    const objectKey = ticketAttachmentObjectKey(
      ticket.organizationId,
      ticket.id,
      attachmentId,
      filename,
    );
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await dependencies.files.putObject({
      bucket: env.minio.bucket,
      objectKey,
      body: bytes,
      contentType,
    });
    const attachment = await dependencies.store.createAttachment({
      id: attachmentId,
      organizationId: ticket.organizationId,
      ticketId: ticket.id,
      uploadedBy: null,
      bucket: env.minio.bucket,
      objectKey,
      originalFilename: filename,
      contentType,
      sizeBytes: bytes.byteLength,
      checksum,
    });
    if (!attachment) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'Ticket not found.');
    }
    return c.json(
      {
        attachment: {
          id: attachment.id,
          ticket_id: attachment.ticketId,
          file_name: attachment.originalFilename,
          file_path: `kode:${attachment.ticketId}/${attachment.id}`,
          file_size: attachment.sizeBytes ?? 0,
          mime_type: attachment.contentType,
        },
      },
      201,
    );
  });

  routes.post('/tickets/:token/close', async (c) => {
    const token = requireUuidValue(c.req.param('token'), 'token');
    const body = await readJson(c);
    const ratingRaw = body.rating ?? body.p_rating;
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ValidationError('Please choose a 1–5 star rating before closing.', {
        field: 'rating',
      });
    }
    const feedback = String(body.feedback ?? body.p_feedback ?? '').trim();
    if (feedback.length < 15) {
      throw new ValidationError(
        'Please describe what was fixed (at least 15 characters) before closing.',
        { field: 'feedback' },
      );
    }
    const closed = await dependencies.store.closeAndRatePublic({
      trackingToken: token,
      rating,
      feedback,
    });
    if (!closed) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'Ticket not found.');
    }
    return c.json({
      ticket_id: closed.ticket.id,
      status: closed.ticket.status,
      rating: closed.rating?.rating ?? null,
      assigned_to: closed.ticket.assignedTo,
      ticket_number: closed.ticket.ticketNumber,
      subject: closed.ticket.subject,
      organization_id: closed.ticket.organizationId,
    });
  });

  return routes;
}
