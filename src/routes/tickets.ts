import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { rejectClientUserOverride } from '../auth/account.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { env } from '../config/env.js';
import { decodeStrictBase64 } from '../http/base64.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { FIELD_LIMITS } from '../http/limits.js';
import { rateLimitWork } from '../http/work-rate-limit.js';
import type { FileStorage } from '../files/storage.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  rejectIdentityOverrides,
  requireId,
  requireUuidValue,
} from '../work/http.js';
import {
  TICKET_ACTION_TAKEN_MIN_CHARS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  ticketAttachmentObjectKey,
  type TicketAttachmentRecord,
  type TicketCommentRecord,
  type TicketPriority,
  type TicketRecord,
  type TicketStatus,
  type TicketStore,
} from '../tickets/store.js';
import type { AuthContext } from '../authorization/types.js';

export type TicketRouteDependencies = {
  store: TicketStore;
  files: FileStorage;
};

function serializeTicket(ticket: TicketRecord) {
  return {
    id: ticket.id,
    organizationId: ticket.organizationId,
    officeId: ticket.officeId,
    linkedCardId: ticket.linkedCardId,
    ticketNumber: ticket.ticketNumber,
    requesterType: ticket.requesterType,
    userId: ticket.userId,
    createdBy: ticket.createdBy,
    assignedTo: ticket.assignedTo,
    requesterEmail: ticket.requesterEmail,
    category: ticket.category,
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    actionTaken: ticket.actionTaken,
    archivedAt: ticket.archivedAt?.toISOString() ?? null,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    closedAt: ticket.closedAt?.toISOString() ?? null,
    closedBy: ticket.closedBy,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    requesterName: ticket.requesterName,
    assignedName: ticket.assignedName,
    officeName: ticket.officeName,
    organizationName: ticket.organizationName,
  };
}

function serializeComment(comment: TicketCommentRecord) {
  return {
    id: comment.id,
    ticketId: comment.ticketId,
    organizationId: comment.organizationId,
    authorId: comment.authorId,
    authorType: comment.authorType,
    body: comment.body,
    visibility: comment.visibility,
    createdAt: comment.createdAt.toISOString(),
    authorName: comment.authorName,
  };
}

function serializeAttachment(attachment: TicketAttachmentRecord) {
  return {
    id: attachment.id,
    ticketId: attachment.ticketId,
    organizationId: attachment.organizationId,
    uploadedBy: attachment.uploadedBy,
    originalFilename: attachment.originalFilename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    checksum: attachment.checksum,
    createdAt: attachment.createdAt.toISOString(),
  };
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

function contentDispositionFilename(filename: string) {
  return filename.replace(/[\r\n"]/g, '_');
}

function authorizeTickets(auth: ReturnType<typeof getAuth>, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: {
      type: 'ticket',
      organizationId,
    },
  });
  return organizationId;
}

function isTicketStaff(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it' ||
    hasPermission(auth.membership.permissions, 'tickets.assign')
  );
}

function canAccessTicket(auth: AuthContext, ticket: TicketRecord) {
  if (isTicketStaff(auth)) {
    return true;
  }
  return ticket.userId === auth.actor.userId;
}

function parseStatus(value: unknown, field: string): TicketStatus {
  if (typeof value !== 'string' || !TICKET_STATUSES.includes(value as TicketStatus)) {
    throw new ValidationError(`${field} is not a valid ticket status.`, { field });
  }
  return value as TicketStatus;
}

function parsePriority(value: unknown, field: string): TicketPriority {
  if (typeof value !== 'string' || !TICKET_PRIORITIES.includes(value as TicketPriority)) {
    throw new ValidationError(`${field} is not a valid ticket priority.`, { field });
  }
  return value as TicketPriority;
}

function parseStatusList(value: string | undefined): TicketStatus[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value.split(',').map((item) => parseStatus(item.trim(), 'status'));
}

function parsePriorityList(value: string | undefined): TicketPriority[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value.split(',').map((item) => parsePriority(item.trim(), 'priority'));
}

export function createTicketRoutes(dependencies: TicketRouteDependencies) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.read');
    const requestedMine =
      c.req.query('mineUserId') ?? c.req.query('mine_user_id') ?? c.req.query('mine');
    if (requestedMine && requestedMine !== 'true' && requestedMine !== '1') {
      rejectClientUserOverride(auth, requestedMine);
    }

    const assignedToRaw = c.req.query('assignedTo') ?? c.req.query('assigned_to');
    const staff = isTicketStaff(auth);
    const requesterUserId = staff
      ? requestedMine === 'true' || requestedMine === '1' || requestedMine === auth.actor.userId
        ? auth.actor.userId
        : undefined
      : auth.actor.userId;

    const limitRaw = c.req.query('limit');
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const tickets = await dependencies.store.list({
      organizationId,
      requesterUserId,
      assignedTo: assignedToRaw ? requireUuidValue(assignedToRaw, 'assignedTo') : undefined,
      statuses: parseStatusList(c.req.query('status')),
      priorities: parsePriorityList(c.req.query('priority')),
      search: c.req.query('search'),
      includeArchived: c.req.query('includeArchived') === 'true',
      limit: parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });

    return c.json({ tickets: tickets.map(serializeTicket) });
  });

  routes.get('/assignable-agents', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.assign');
    const agents = await dependencies.store.listAssignableAgents(organizationId);
    return c.json({
      agents: agents.map((agent) => ({
        id: agent.userId,
        fullName: agent.fullName,
        email: agent.email,
        officeId: agent.officeId,
        officeName: agent.officeName,
        officeSlug: agent.officeSlug,
      })),
    });
  });

  routes.get('/by-card/:cardId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.read');
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    const ticket = await dependencies.store.getByCardId(organizationId, cardId);
    if (!ticket || !canAccessTicket(auth, ticket)) {
      return c.json({ ticket: null });
    }
    return c.json({ ticket: serializeTicket(ticket) });
  });

  routes.get('/:ticketId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.read');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const ticket = await dependencies.store.getById(organizationId, ticketId);
    if (!ticket || !canAccessTicket(auth, ticket)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    const comments = await dependencies.store.listComments(organizationId, ticketId);
    const attachments = await dependencies.store.listAttachments(
      organizationId,
      ticketId,
    );
    const visibleComments = isTicketStaff(auth)
      ? comments
      : comments.filter((comment) => comment.visibility === 'public');
    return c.json({
      ticket: serializeTicket(ticket),
      comments: visibleComments.map(serializeComment),
      attachments: attachments.map(serializeAttachment),
    });
  });

  routes.post('/', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.create');
    await rateLimitWork(c, 'mutation');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);

    let assignedTo: string | null = null;
    const requestedAssignee = body.assignedTo ?? body.assigned_to;
    if (requestedAssignee !== undefined && requestedAssignee !== null) {
      authorizeTickets(auth, 'tickets.assign');
      assignedTo = requireUuidValue(requestedAssignee, 'assignedTo');
      const member = await dependencies.store.getOrganizationMember(
        organizationId,
        assignedTo,
      );
      if (!member) {
        throw new NotFoundError(
          'MEMBER_NOT_FOUND',
          'The user was not found in this organization.',
        );
      }
    }

    const ticket = await dependencies.store.create({
      organizationId,
      officeId: auth.membership.officeId,
      userId: auth.actor.userId,
      createdBy: auth.actor.userId,
      requesterEmail: auth.actor.email,
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
      assignedTo,
    });

    return c.json({ ticket: serializeTicket(ticket) }, 201);
  });

  routes.patch('/:ticketId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.update');
    await rateLimitWork(c, 'mutation');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getById(organizationId, ticketId);
    if (!existing || !canAccessTicket(auth, existing)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }

    const staff = isTicketStaff(auth);
    const hasAssigneeField = Object.prototype.hasOwnProperty.call(body, 'assignedTo') ||
      Object.prototype.hasOwnProperty.call(body, 'assigned_to');
    if (hasAssigneeField) {
      authorizeTickets(auth, 'tickets.assign');
    }

    const nextStatus =
      body.status === undefined ? undefined : parseStatus(body.status, 'status');
    if (nextStatus === 'closed' && existing.userId !== auth.actor.userId) {
      throw new ValidationError(
        'Only the person who submitted the ticket can close it.',
        { field: 'status' },
      );
    }
    if (
      nextStatus === 'resolved' &&
      existing.status !== 'closed' &&
      existing.status !== 'resolved'
    ) {
      throw new ValidationError(
        'Wait for the submitter to close the ticket first.',
        { field: 'status' },
      );
    }
    const actionTaken =
      body.actionTaken !== undefined || body.action_taken !== undefined
        ? readOptionalString(
            body.actionTaken ?? body.action_taken,
            'actionTaken',
            FIELD_LIMITS.ticketActionTaken,
          )
        : existing.actionTaken;
    if (
      nextStatus === 'resolved' &&
      existing.status !== 'resolved' &&
      (actionTaken?.trim().length ?? 0) < TICKET_ACTION_TAKEN_MIN_CHARS
    ) {
      throw new ValidationError(
        `Record action taken (at least ${TICKET_ACTION_TAKEN_MIN_CHARS} characters) before marking this ticket resolved.`,
        { field: 'actionTaken' },
      );
    }

    if (!staff) {
      if (nextStatus && nextStatus !== 'closed') {
        throw new ValidationError('Requesters can only close their own tickets.', {
          field: 'status',
        });
      }
    }

    let assignedTo: string | null | undefined;
    if (hasAssigneeField) {
      const requestedAssignee = body.assignedTo ?? body.assigned_to ?? null;
      assignedTo =
        requestedAssignee === null
          ? null
          : requireUuidValue(requestedAssignee, 'assignedTo');
      if (assignedTo) {
        const member = await dependencies.store.getOrganizationMember(
          organizationId,
          assignedTo,
        );
        if (!member) {
          throw new NotFoundError(
            'MEMBER_NOT_FOUND',
            'The user was not found in this organization.',
          );
        }
      }
    }

    const ticket = await dependencies.store.update(
      organizationId,
      ticketId,
      {
        status: nextStatus,
        priority:
          body.priority === undefined
            ? undefined
            : parsePriority(body.priority, 'priority'),
        category:
          body.category === undefined
            ? undefined
            : readRequiredText(body.category, 'category', FIELD_LIMITS.ticketCategory),
        subject:
          body.subject === undefined
            ? undefined
            : readRequiredText(body.subject, 'subject', FIELD_LIMITS.ticketSubject),
        description:
          body.description === undefined
            ? undefined
            : readRequiredText(
                body.description,
                'description',
                FIELD_LIMITS.ticketDescription,
              ),
        actionTaken:
          body.actionTaken !== undefined || body.action_taken !== undefined
            ? (actionTaken ?? null)
            : undefined,
        assignedTo,
      },
      auth.actor.userId,
    );
    if (!ticket) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    return c.json({ ticket: serializeTicket(ticket) });
  });

  routes.post('/:ticketId/comments', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.comment');
    await rateLimitWork(c, 'mutation');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getById(organizationId, ticketId);
    if (!existing || !canAccessTicket(auth, existing)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }

    const visibilityRaw = readOptionalString(body.visibility, 'visibility', 16) ?? 'public';
    if (visibilityRaw !== 'public' && visibilityRaw !== 'internal') {
      throw new ValidationError('visibility must be public or internal.', {
        field: 'visibility',
      });
    }
    if (!isTicketStaff(auth) && visibilityRaw === 'internal') {
      throw new ValidationError('Requesters cannot add internal comments.', {
        field: 'visibility',
      });
    }

    const comment = await dependencies.store.createComment({
      organizationId,
      ticketId,
      authorId: auth.actor.userId,
      body: readRequiredText(body.body, 'body', FIELD_LIMITS.ticketCommentBody),
      visibility: visibilityRaw,
    });
    if (!comment) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    return c.json({ comment: serializeComment(comment) }, 201);
  });

  routes.get('/:ticketId/attachments', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.attachments.read');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const existing = await dependencies.store.getById(organizationId, ticketId);
    if (!existing || !canAccessTicket(auth, existing)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    const attachments = await dependencies.store.listAttachments(
      organizationId,
      ticketId,
    );
    return c.json({ attachments: attachments.map(serializeAttachment) });
  });

  routes.post('/:ticketId/attachments', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.attachments.create');
    await rateLimitWork(c, 'attachment');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getById(organizationId, ticketId);
    if (!existing || !canAccessTicket(auth, existing)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    const filename = safeFilename(
      readRequiredText(body.filename ?? body.originalFilename, 'filename', FIELD_LIMITS.filename),
    );
    const contentType =
      readOptionalString(
        body.contentType ?? body.content_type,
        'contentType',
        FIELD_LIMITS.contentType,
      ) ?? 'application/octet-stream';
    if (!isAllowedTicketAttachment(contentType, filename)) {
      throw new ValidationError(
        'Only images, PDFs, and plain text attachments are allowed.',
        { field: 'contentType' },
      );
    }
    const content = decodeStrictBase64(
      body.contentBase64 ?? body.content,
      'contentBase64',
      c.get('limits').maxAttachmentBytes,
    );
    const attachmentId = randomUUID();
    const objectKey = ticketAttachmentObjectKey(
      organizationId,
      ticketId,
      attachmentId,
      filename,
    );
    await dependencies.files.putObject({
      bucket: env.minio.bucket,
      objectKey,
      body: content,
      contentType,
    });
    const attachment = await dependencies.store.createAttachment({
      id: attachmentId,
      organizationId,
      ticketId,
      uploadedBy: auth.actor.userId,
      bucket: env.minio.bucket,
      objectKey,
      originalFilename: filename,
      contentType,
      sizeBytes: content.byteLength,
      checksum: createHash('sha256').update(content).digest('hex'),
    });
    if (!attachment) {
      await dependencies.files.deleteObject(env.minio.bucket, objectKey);
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    return c.json({ attachment: serializeAttachment(attachment) }, 201);
  });

  routes.get('/:ticketId/attachments/:attachmentId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.attachments.read');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const attachmentId = requireId(c.req.param('attachmentId'), 'attachmentId');
    const existing = await dependencies.store.getById(organizationId, ticketId);
    if (!existing || !canAccessTicket(auth, existing)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    const attachment = await dependencies.store.getAttachmentById(
      organizationId,
      attachmentId,
    );
    if (!attachment || attachment.ticketId !== ticketId) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    return c.json({ attachment: serializeAttachment(attachment) });
  });

  routes.get('/:ticketId/attachments/:attachmentId/content', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.attachments.read');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const attachmentId = requireId(c.req.param('attachmentId'), 'attachmentId');
    const existing = await dependencies.store.getById(organizationId, ticketId);
    if (!existing || !canAccessTicket(auth, existing)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    const attachment = await dependencies.store.getAttachmentById(
      organizationId,
      attachmentId,
    );
    if (!attachment || attachment.ticketId !== ticketId) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    const stored = await dependencies.files.getObject(
      attachment.bucket,
      attachment.objectKey,
    );
    if (!stored) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    return new Response(Uint8Array.from(stored.body), {
      status: 200,
      headers: {
        'content-type': stored.contentType ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${contentDispositionFilename(attachment.originalFilename)}"`,
        'cache-control': 'private, no-store',
      },
    });
  });

  routes.delete('/:ticketId/attachments/:attachmentId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.attachments.delete');
    await rateLimitWork(c, 'mutation');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const attachmentId = requireId(c.req.param('attachmentId'), 'attachmentId');
    const existing = await dependencies.store.getById(organizationId, ticketId);
    if (!existing || !canAccessTicket(auth, existing)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }
    const attachment = await dependencies.store.getAttachmentById(
      organizationId,
      attachmentId,
    );
    if (!attachment || attachment.ticketId !== ticketId) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    const deleted = await dependencies.store.deleteAttachment(
      organizationId,
      attachmentId,
    );
    if (!deleted) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    await dependencies.files.deleteObject(attachment.bucket, attachment.objectKey);
    return c.body(null, 204);
  });

  return routes;
}
