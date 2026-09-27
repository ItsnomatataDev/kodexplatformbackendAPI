import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { rejectClientUserOverride } from '../auth/account.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { env } from '../config/env.js';
import { decodeStrictBase64 } from '../http/base64.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { FIELD_LIMITS } from '../http/limits.js';
import { rateLimitWork } from '../http/work-rate-limit.js';
import { streamStoredMedia, attachmentDisposition } from '../content/media-stream.js';
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
import {
  canSeeTicketWorkIntelligence,
  canTriggerMonthlyTicketReport,
} from '../tickets/intelligence.js';
import { sendAttendanceEmail } from '../email/attendance-mailer.js';

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
    trackingToken: ticket.trackingToken,
    requesterType: ticket.requesterType,
    userId: ticket.userId,
    createdBy: ticket.createdBy,
    assignedTo: ticket.assignedTo,
    requesterEmail: ticket.requesterEmail,
    externalName: ticket.externalName,
    externalCompany: ticket.externalCompany,
    externalPhone: ticket.externalPhone,
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
    closedByEmail: ticket.closedByEmail,
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
    externalName: comment.externalName,
    externalEmail: comment.externalEmail,
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

function serializeRating(
  rating: Awaited<ReturnType<TicketStore['getRating']>>,
) {
  if (!rating) return null;
  return {
    id: rating.id,
    ticket_id: rating.ticketId,
    organization_id: rating.organizationId,
    rating: rating.rating,
    feedback: rating.feedback,
    external_email: rating.externalEmail,
    created_by: rating.createdBy,
    rated_assignee_id: rating.ratedAssigneeId,
    created_at: rating.createdAt.toISOString(),
  };
}

const TICKET_CLOSE_FEEDBACK_MIN_CHARS = 15;

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

  routes.post('/work-intelligence', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.read');
    await rateLimitWork(c, 'mutation');
    const officeSlug = await dependencies.store.getMemberOfficeSlug(
      organizationId,
      auth.actor.userId,
    );
    if (!canSeeTicketWorkIntelligence(auth, officeSlug)) {
      return c.json({ allowed: false, tickets: [] });
    }
    const body = await readJson(c);
    const rawIds = body.ticketIds ?? body.ticket_ids ?? body.p_ticket_ids;
    const ticketIds = Array.isArray(rawIds)
      ? rawIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => requireUuidValue(value, 'ticketIds'))
      : [];
    const tickets = await dependencies.store.getWorkIntelligence(
      organizationId,
      ticketIds,
    );
    return c.json({
      allowed: true,
      tickets: tickets.map((row) => ({
        allowed: row.allowed,
        ticket_id: row.ticketId,
        tracked_seconds: row.trackedSeconds,
        running: row.running,
        clock_state: row.clockState,
        last_heartbeat_at: row.lastHeartbeatAt,
        minutes_low: row.minutesLow,
        minutes_median: row.minutesMedian,
        minutes_high: row.minutesHigh,
        sample_count: row.sampleCount,
        confidence: row.confidence,
        error: row.error,
      })),
    });
  });

  routes.post('/work-intelligence/:ticketId/heartbeat', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.read');
    await rateLimitWork(c, 'mutation');
    const officeSlug = await dependencies.store.getMemberOfficeSlug(
      organizationId,
      auth.actor.userId,
    );
    if (!canSeeTicketWorkIntelligence(auth, officeSlug)) {
      return c.json({ allowed: false });
    }
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const intel = await dependencies.store.heartbeatWork(
      organizationId,
      ticketId,
      auth.actor.userId,
    );
    if (!intel) {
      return c.json({ allowed: true, error: 'not_found' });
    }
    return c.json({
      allowed: intel.allowed,
      ticket_id: intel.ticketId,
      tracked_seconds: intel.trackedSeconds,
      running: intel.running,
      clock_state: intel.clockState,
      last_heartbeat_at: intel.lastHeartbeatAt,
      minutes_low: intel.minutesLow,
      minutes_median: intel.minutesMedian,
      minutes_high: intel.minutesHigh,
      sample_count: intel.sampleCount,
      confidence: intel.confidence,
      error: intel.error,
    });
  });

  routes.post('/work-intelligence/:ticketId/stop', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.read');
    await rateLimitWork(c, 'mutation');
    const officeSlug = await dependencies.store.getMemberOfficeSlug(
      organizationId,
      auth.actor.userId,
    );
    if (!canSeeTicketWorkIntelligence(auth, officeSlug)) {
      return c.json({ allowed: false });
    }
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const intel = await dependencies.store.stopWork(
      organizationId,
      ticketId,
      auth.actor.userId,
    );
    if (!intel) {
      return c.json({ allowed: true, error: 'not_found' });
    }
    return c.json({
      allowed: intel.allowed,
      ticket_id: intel.ticketId,
      tracked_seconds: intel.trackedSeconds,
      running: intel.running,
      clock_state: intel.clockState,
      last_heartbeat_at: intel.lastHeartbeatAt,
      minutes_low: intel.minutesLow,
      minutes_median: intel.minutesMedian,
      minutes_high: intel.minutesHigh,
      sample_count: intel.sampleCount,
      confidence: intel.confidence,
      error: intel.error,
    });
  });

  routes.post('/monthly-report', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.read');
    await rateLimitWork(c, 'mutation');
    if (!canTriggerMonthlyTicketReport(auth)) {
      throw new ForbiddenError(
        'INSUFFICIENT_PERMISSION',
        'Only IT or admin roles can trigger the monthly IT ticket report.',
      );
    }
    const body = await readJson(c);
    const year = Number(body.year);
    const month = Number(body.month);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new ValidationError('year must be a valid calendar year.', {
        field: 'year',
      });
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new ValidationError('month must be between 1 and 12.', {
        field: 'month',
      });
    }
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    const [tickets, recipients] = await Promise.all([
      dependencies.store.listMonthlyReportTickets(organizationId, from, to),
      dependencies.store.listMonthlyReportRecipients(organizationId),
    ]);
    if (recipients.length === 0) {
      return c.json({
        ok: true,
        sent: 0,
        skipped: 1,
        totalRecipients: 0,
        errors: ['No admins found to send report to.'],
      });
    }

    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let resolved = 0;
    for (const ticket of tickets) {
      byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
      byPriority[ticket.priority] = (byPriority[ticket.priority] ?? 0) + 1;
      byCategory[ticket.category] = (byCategory[ticket.category] ?? 0) + 1;
      if (ticket.status === 'resolved' || ticket.status === 'closed') {
        resolved += 1;
      }
    }
    const label = from.toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const subject = `IT Monthly Report — ${label}`;
    const text = [
      `IT Service Desk Monthly Report — ${label}`,
      '',
      `Total tickets: ${tickets.length}`,
      `Resolved/closed: ${resolved}`,
      '',
      'By status:',
      ...Object.entries(byStatus).map(([key, value]) => `  ${key}: ${value}`),
      '',
      'By priority:',
      ...Object.entries(byPriority).map(([key, value]) => `  ${key}: ${value}`),
      '',
      'Top categories:',
      ...Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([key, value]) => `  ${key}: ${value}`),
    ].join('\n');

    const errors: string[] = [];
    let sent = 0;
    for (const recipient of recipients) {
      const ok = await sendAttendanceEmail({
        to: recipient.email,
        subject,
        text,
      });
      if (ok) sent += 1;
      else errors.push(`Failed to email ${recipient.email}`);
    }

    return c.json({
      ok: true,
      sent,
      skipped: 0,
      totalRecipients: recipients.length,
      errors,
    });
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
    const [comments, attachments, rating] = await Promise.all([
      dependencies.store.listComments(organizationId, ticketId),
      dependencies.store.listAttachments(organizationId, ticketId),
      dependencies.store.getRating(organizationId, ticketId),
    ]);
    const visibleComments = isTicketStaff(auth)
      ? comments
      : comments.filter((comment) => comment.visibility === 'public');
    return c.json({
      ticket: serializeTicket(ticket),
      comments: visibleComments.map(serializeComment),
      attachments: attachments.map(serializeAttachment),
      rating: serializeRating(rating),
    });
  });

  routes.post('/:ticketId/close', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = authorizeTickets(auth, 'tickets.update');
    await rateLimitWork(c, 'mutation');
    const ticketId = requireId(c.req.param('ticketId'), 'ticketId');
    const existing = await dependencies.store.getById(organizationId, ticketId);
    if (!existing || !canAccessTicket(auth, existing)) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
    }

    const isRequester = existing.userId === auth.actor.userId;
    const staff = isTicketStaff(auth);
    if (!isRequester && !staff) {
      throw new ForbiddenError(
        'TICKET_CLOSE_FORBIDDEN',
        'Only the requester or service-desk staff can close this ticket.',
      );
    }

    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const ratingRaw = body.rating ?? body.p_rating;
    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ValidationError('Please choose a 1–5 star rating before closing.', {
        field: 'rating',
      });
    }
    const feedback = String(body.feedback ?? body.p_feedback ?? '').trim();
    if (feedback.length < TICKET_CLOSE_FEEDBACK_MIN_CHARS) {
      throw new ValidationError(
        `Please describe what was fixed (at least ${TICKET_CLOSE_FEEDBACK_MIN_CHARS} characters) before closing.`,
        { field: 'feedback' },
      );
    }

    const closed = await dependencies.store.closeAndRate({
      organizationId,
      ticketId,
      rating,
      feedback,
      closedBy: auth.actor.userId,
      closedByEmail: auth.actor.email,
      createdBy: auth.actor.userId,
    });
    if (!closed) {
      throw new NotFoundError('TICKET_NOT_FOUND', 'The ticket was not found.');
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
