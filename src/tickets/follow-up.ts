import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { SimpleEmail } from '../email/attendance-mailer.js';
import { APP_URL } from '../email/branded-templates.js';
import { ConflictError, TooManyRequestsError } from '../http/errors.js';
import { NOTIFICATION_TYPES, type NotificationStore } from '../notifications/store.js';
import type { TicketCommentRecord, TicketRecord } from './store.js';

export const TICKET_FOLLOW_UP_COOLDOWN_MS = 60 * 60 * 1000;
export const TICKET_FOLLOW_UP_MAX_CHARS = 2_000;

const CLOSED_STATUSES = new Set(['resolved', 'closed']);

export type TicketFollowUpInput = {
  notifications: NotificationStore;
  sendEmail: (message: SimpleEmail) => Promise<boolean>;
  ticket: TicketRecord;
  message: string;
  requesterUserId: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  createComment: (body: string) => Promise<TicketCommentRecord | null>;
  now?: Date;
};

export function assertTicketAcceptsFollowUp(ticket: TicketRecord) {
  if (CLOSED_STATUSES.has(ticket.status)) {
    throw new ConflictError(
      'TICKET_FOLLOW_UP_CLOSED',
      'This ticket is already resolved or closed.',
    );
  }
  if (!ticket.assignedTo) {
    throw new ConflictError(
      'TICKET_FOLLOW_UP_UNASSIGNED',
      'No technician has been assigned yet. IT will pick up your ticket shortly.',
    );
  }
}

function preview(body: string) {
  const trimmed = body.trim();
  return trimmed.length <= 280 ? trimmed : `${trimmed.slice(0, 277)}...`;
}

export async function sendTicketFollowUp(input: TicketFollowUpInput) {
  const { ticket } = input;
  assertTicketAcceptsFollowUp(ticket);
  const technicianId = ticket.assignedTo as string;
  const nowMs = (input.now ?? new Date()).getTime();
  const windowIndex = Math.floor(nowMs / TICKET_FOLLOW_UP_COOLDOWN_MS);
  const requesterLabel =
    input.requesterName?.trim() ||
    input.requesterEmail?.trim() ||
    ticket.requesterName ||
    ticket.externalName ||
    'The requester';
  const message = input.message.trim();

  const claimed = await input.notifications.create({
    organizationId: ticket.organizationId,
    recipientUserId: technicianId,
    actorUserId: input.requesterUserId,
    type: NOTIFICATION_TYPES.ticketFollowUp,
    title: `Follow-up on ${ticket.ticketNumber}`,
    message: `${requesterLabel}: ${preview(message)}`,
    entityType: 'ticket',
    entityId: ticket.id,
    actionUrl: `/it/support/${ticket.id}`,
    priority: 'high',
    category: 'tickets',
    dedupeKey: `ticket_follow_up:${ticket.id}:${windowIndex}`,
    metadata: {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      event: 'follow_up',
      requesterName: requesterLabel,
      requesterEmail: input.requesterEmail,
    },
  });
  if (claimed === 'duplicate') {
    const retryAfterSeconds = Math.ceil(
      ((windowIndex + 1) * TICKET_FOLLOW_UP_COOLDOWN_MS - nowMs) / 1000,
    );
    throw new TooManyRequestsError(
      retryAfterSeconds,
      'A follow-up was already sent to the technician recently. Please wait before sending another.',
    );
  }

  const comment = await input.createComment(`Follow-up: ${message}`);

  const recipients = await input.notifications.getRecipientEmails(
    [technicianId],
    ticket.organizationId,
  );
  const technician = recipients.get(technicianId);
  let emailed = false;
  if (technician?.email) {
    const origin = (env.appPublicUrl || APP_URL).replace(/\/+$/, '');
    const actionUrl = `${origin}/it/support/${ticket.id}`;
    const contact = input.requesterEmail ? ` (${input.requesterEmail})` : '';
    try {
      emailed = await input.sendEmail({
        to: technician.email,
        subject: `Follow-up on ticket ${ticket.ticketNumber}: ${ticket.subject}`,
        firstName: technician.fullName ?? undefined,
        actionUrl,
        actionLabel: 'Open ticket',
        text: [
          `${requesterLabel}${contact} sent a follow-up on ticket ${ticket.ticketNumber} (${ticket.subject}):`,
          '',
          message,
          '',
          `Open the ticket: ${actionUrl}`,
        ].join('\n'),
      });
    } catch (error) {
      logger.warn(
        { err: error, ticketId: ticket.id },
        'Failed to email technician about a ticket follow-up',
      );
    }
  }

  return { comment, emailed };
}
