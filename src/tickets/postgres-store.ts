import { db } from '../db/pool.js';
import {
  estimateConfidence,
  MONTHLY_REPORT_ADMIN_ROLES,
  percentile,
} from './intelligence.js';
import type {
  CloseAndRateTicketInput,
  ClosePublicTicketInput,
  CreatePublicTicketCommentInput,
  CreatePublicTicketInput,
  CreateTicketAttachmentInput,
  CreateTicketCommentInput,
  CreateTicketInput,
  ListTicketsInput,
  MonthlyTicketReportRecipient,
  MonthlyTicketReportTicket,
  PublicTicketOffice,
  PublicTicketOrganization,
  TicketAgentRecord,
  TicketAttachmentRecord,
  TicketCommentRecord,
  TicketPriority,
  TicketRatingRecord,
  TicketRecord,
  TicketStatus,
  TicketStore,
  TicketWorkClockState,
  TicketWorkIntelligenceRecord,
  UpdateTicketInput,
} from './store.js';

type TicketRow = {
  id: string;
  organization_id: string;
  office_id: string | null;
  linked_card_id: string | null;
  ticket_number: string;
  tracking_token: string;
  requester_type: 'internal' | 'external';
  user_id: string | null;
  created_by: string | null;
  assigned_to: string | null;
  requester_email: string | null;
  external_name: string | null;
  external_company: string | null;
  external_phone: string | null;
  category: string;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  action_taken: string | null;
  archived_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  closed_by_email: string | null;
  created_at: Date;
  updated_at: Date;
  requester_name?: string | null;
  assigned_name?: string | null;
  office_name?: string | null;
  organization_name?: string | null;
};

type CommentRow = {
  id: string;
  ticket_id: string;
  organization_id: string;
  author_id: string | null;
  author_type: 'internal' | 'external';
  body: string;
  visibility: 'public' | 'internal';
  created_at: Date;
  author_name?: string | null;
  external_name?: string | null;
  external_email?: string | null;
};

type RatingRow = {
  id: string;
  ticket_id: string;
  organization_id: string;
  rating: number;
  feedback: string | null;
  created_by: string | null;
  external_email: string | null;
  rated_assignee_id: string | null;
  created_at: Date;
};

type AttachmentRow = {
  id: string;
  ticket_id: string;
  organization_id: string;
  uploaded_by: string | null;
  bucket: string;
  object_key: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: string | number | null;
  checksum: string | null;
  created_at: Date;
};

const TICKET_COLUMNS = `
  ticket.id,
  ticket.organization_id,
  ticket.office_id,
  ticket.linked_card_id,
  ticket.ticket_number,
  ticket.tracking_token,
  ticket.requester_type,
  ticket.user_id,
  ticket.created_by,
  ticket.assigned_to,
  ticket.requester_email,
  ticket.external_name,
  ticket.external_company,
  ticket.external_phone,
  ticket.category,
  ticket.subject,
  ticket.description,
  ticket.status,
  ticket.priority,
  ticket.action_taken,
  ticket.archived_at,
  ticket.resolved_at,
  ticket.closed_at,
  ticket.closed_by,
  ticket.closed_by_email,
  ticket.created_at,
  ticket.updated_at,
  COALESCE(requester_profile.full_name, ticket.external_name) AS requester_name,
  assigned_profile.full_name AS assigned_name,
  office.name AS office_name,
  org.name AS organization_name
`;

const TICKET_FROM = `
  tickets.tickets ticket
  JOIN organizations.organizations org
    ON org.id = ticket.organization_id
  LEFT JOIN organizations.offices office
    ON office.id = ticket.office_id
  LEFT JOIN identity.user_profiles requester_profile
    ON requester_profile.user_id = ticket.user_id
  LEFT JOIN identity.user_profiles assigned_profile
    ON assigned_profile.user_id = ticket.assigned_to
`;

function mapTicket(row: TicketRow): TicketRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    linkedCardId: row.linked_card_id,
    ticketNumber: row.ticket_number,
    trackingToken: row.tracking_token,
    requesterType: row.requester_type,
    userId: row.user_id,
    createdBy: row.created_by,
    assignedTo: row.assigned_to,
    requesterEmail: row.requester_email,
    externalName: row.external_name,
    externalCompany: row.external_company,
    externalPhone: row.external_phone,
    category: row.category,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    actionTaken: row.action_taken,
    archivedAt: row.archived_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closedByEmail: row.closed_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requesterName: row.requester_name ?? null,
    assignedName: row.assigned_name ?? null,
    officeName: row.office_name ?? null,
    organizationName: row.organization_name ?? null,
  };
}

function mapComment(row: CommentRow): TicketCommentRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    organizationId: row.organization_id,
    authorId: row.author_id,
    authorType: row.author_type,
    body: row.body,
    visibility: row.visibility,
    createdAt: row.created_at,
    authorName:
      row.author_name ??
      row.external_name ??
      null,
    externalName: row.external_name ?? null,
    externalEmail: row.external_email ?? null,
  };
}

function mapRating(row: RatingRow): TicketRatingRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    organizationId: row.organization_id,
    rating: row.rating,
    feedback: row.feedback,
    createdBy: row.created_by,
    externalEmail: row.external_email,
    ratedAssigneeId: row.rated_assignee_id,
    createdAt: row.created_at,
  };
}

function mapAttachment(row: AttachmentRow): TicketAttachmentRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    organizationId: row.organization_id,
    uploadedBy: row.uploaded_by,
    bucket: row.bucket,
    objectKey: row.object_key,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

export class PostgresTicketStore implements TicketStore {
  async list(input: ListTicketsInput) {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    const statuses = input.statuses ?? [];
    const priorities = input.priorities ?? [];
    const result = await db.query<TicketRow>(
      `
        SELECT ${TICKET_COLUMNS}
        FROM ${TICKET_FROM}
        WHERE ticket.organization_id = $1
          AND ($2::boolean IS TRUE OR ticket.archived_at IS NULL)
          AND ($3::uuid IS NULL OR ticket.user_id = $3)
          AND ($4::uuid IS NULL OR ticket.assigned_to = $4)
          AND (cardinality($5::text[]) = 0 OR ticket.status = ANY($5::text[]))
          AND (cardinality($6::text[]) = 0 OR ticket.priority = ANY($6::text[]))
          AND (
            $7::text IS NULL
            OR ticket.ticket_number ILIKE '%' || $7 || '%'
            OR ticket.subject ILIKE '%' || $7 || '%'
            OR ticket.description ILIKE '%' || $7 || '%'
          )
        ORDER BY ticket.created_at DESC, ticket.id DESC
        LIMIT $8
      `,
      [
        input.organizationId,
        input.includeArchived ?? false,
        input.requesterUserId ?? null,
        input.assignedTo ?? null,
        statuses,
        priorities,
        input.search?.trim() || null,
        limit,
      ],
    );
    return result.rows.map(mapTicket);
  }

  async getById(organizationId: string, ticketId: string) {
    const result = await db.query<TicketRow>(
      `
        SELECT ${TICKET_COLUMNS}
        FROM ${TICKET_FROM}
        WHERE ticket.organization_id = $1
          AND ticket.id = $2
      `,
      [organizationId, ticketId],
    );
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  }

  async getByCardId(organizationId: string, cardId: string) {
    const result = await db.query<TicketRow>(
      `
        SELECT ${TICKET_COLUMNS}
        FROM ${TICKET_FROM}
        WHERE ticket.organization_id = $1
          AND (
            ticket.linked_card_id = $2
            OR ticket.id = (
              SELECT card.legacy_ticket_id
              FROM work.cards card
              WHERE card.organization_id = $1
                AND card.id = $2
            )
          )
        ORDER BY ticket.created_at DESC
        LIMIT 1
      `,
      [organizationId, cardId],
    );
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  }

  async getByTrackingToken(trackingToken: string) {
    const result = await db.query<TicketRow>(
      `
        SELECT ${TICKET_COLUMNS}
        FROM ${TICKET_FROM}
        WHERE ticket.tracking_token = $1
        LIMIT 1
      `,
      [trackingToken],
    );
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  }

  async create(input: CreateTicketInput) {
    const assignedTo = input.assignedTo ?? null;
    const result = await db.query<TicketRow>(
      `
        WITH numbered AS (
          SELECT
            COALESCE(
              NULLIF(upper(left(regexp_replace(org.slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''),
              'SD'
            ) AS prefix,
            (
              SELECT COUNT(*) + 1
              FROM tickets.tickets existing
              WHERE existing.organization_id = $1
            ) AS seq
          FROM organizations.organizations org
          WHERE org.id = $1
        )
        INSERT INTO tickets.tickets (
          organization_id,
          office_id,
          user_id,
          created_by,
          assigned_to,
          requester_email,
          category,
          subject,
          description,
          priority,
          status,
          ticket_number,
          requester_type
        )
        SELECT
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          CASE WHEN $5::uuid IS NULL THEN 'open' ELSE 'assigned' END,
          numbered.prefix || '-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(numbered.seq::text, 5, '0'),
          'internal'
        FROM numbered
        RETURNING id
      `,
      [
        input.organizationId,
        input.officeId ?? null,
        input.userId,
        input.createdBy,
        assignedTo,
        input.requesterEmail ?? null,
        input.category,
        input.subject,
        input.description,
        input.priority ?? 'medium',
      ],
    );
    const created = result.rows[0];
    if (!created) {
      throw new Error('Failed to create ticket.');
    }
    const ticket = await this.getById(input.organizationId, created.id);
    if (!ticket) {
      throw new Error('Failed to load created ticket.');
    }
    return ticket;
  }

  async createPublic(input: CreatePublicTicketInput) {
    const result = await db.query<{ id: string }>(
      `
        WITH numbered AS (
          SELECT
            COALESCE(
              NULLIF(upper(left(regexp_replace(org.slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''),
              'SD'
            ) AS prefix,
            (
              SELECT COUNT(*) + 1
              FROM tickets.tickets existing
              WHERE existing.organization_id = $1
            ) AS seq
          FROM organizations.organizations org
          WHERE org.id = $1
        )
        INSERT INTO tickets.tickets (
          organization_id,
          office_id,
          requester_type,
          external_name,
          external_company,
          requester_email,
          external_phone,
          category,
          subject,
          description,
          priority,
          status,
          ticket_number
        )
        SELECT
          $1, $2, 'external', $3, $4, $5, $6, $7, $8, $9, $10, 'open',
          numbered.prefix || '-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(numbered.seq::text, 5, '0')
        FROM numbered
        RETURNING id
      `,
      [
        input.organizationId,
        input.officeId,
        input.externalName,
        input.externalCompany ?? null,
        input.requesterEmail.toLowerCase(),
        input.externalPhone ?? null,
        input.category,
        input.subject,
        input.description,
        input.priority ?? 'medium',
      ],
    );
    const created = result.rows[0];
    if (!created) {
      throw new Error('Failed to create public ticket.');
    }
    const ticket = await this.getById(input.organizationId, created.id);
    if (!ticket) {
      throw new Error('Failed to load created public ticket.');
    }
    return ticket;
  }

  async update(
    organizationId: string,
    ticketId: string,
    input: UpdateTicketInput,
    actorUserId: string,
  ) {
    const current = await this.getById(organizationId, ticketId);
    if (!current) {
      return null;
    }

    const assignedTo =
      input.assignedTo !== undefined ? input.assignedTo : current.assignedTo;
    let status = input.status ?? current.status;
    if (input.assignedTo && current.status === 'open' && input.status === undefined) {
      status = 'assigned';
    }
    if (
      input.assignedTo === null &&
      current.status === 'assigned' &&
      input.status === undefined
    ) {
      status = 'open';
    }

    const result = await db.query<TicketRow>(
      `
        UPDATE tickets.tickets
        SET
          status = $3,
          priority = $4,
          category = $5,
          subject = $6,
          description = $7,
          action_taken = $8,
          assigned_to = $9,
          linked_card_id = $10,
          resolved_at = CASE
            WHEN $3 = 'resolved' THEN COALESCE(resolved_at, NOW())
            ELSE resolved_at
          END,
          closed_at = CASE
            WHEN $3 = 'closed' THEN COALESCE(closed_at, NOW())
            ELSE closed_at
          END,
          closed_by = CASE
            WHEN $3 = 'closed' THEN COALESCE(closed_by, $11)
            ELSE closed_by
          END,
          updated_at = NOW()
        WHERE organization_id = $1
          AND id = $2
        RETURNING id
      `,
      [
        organizationId,
        ticketId,
        status,
        input.priority ?? current.priority,
        input.category ?? current.category,
        input.subject ?? current.subject,
        input.description ?? current.description,
        input.actionTaken !== undefined ? input.actionTaken : current.actionTaken,
        assignedTo,
        input.linkedCardId !== undefined ? input.linkedCardId : current.linkedCardId,
        actorUserId,
      ],
    );
    if (!result.rows[0]) {
      return null;
    }
    return this.getById(organizationId, ticketId);
  }

  async listComments(organizationId: string, ticketId: string) {
    const result = await db.query<CommentRow>(
      `
        SELECT
          comment.id,
          comment.ticket_id,
          comment.organization_id,
          comment.author_id,
          comment.author_type,
          comment.body,
          comment.visibility,
          comment.created_at,
          comment.external_name,
          comment.external_email,
          COALESCE(profile.full_name, comment.external_name) AS author_name
        FROM tickets.ticket_comments comment
        LEFT JOIN identity.user_profiles profile
          ON profile.user_id = comment.author_id
        WHERE comment.organization_id = $1
          AND comment.ticket_id = $2
        ORDER BY comment.created_at ASC, comment.id ASC
      `,
      [organizationId, ticketId],
    );
    return result.rows.map(mapComment);
  }

  async createComment(input: CreateTicketCommentInput) {
    const result = await db.query<CommentRow>(
      `
        WITH inserted AS (
          INSERT INTO tickets.ticket_comments (
            ticket_id,
            organization_id,
            author_id,
            author_type,
            body,
            visibility
          )
          SELECT ticket.id, ticket.organization_id, $3, 'internal', $4, $5
          FROM tickets.tickets ticket
          WHERE ticket.organization_id = $1
            AND ticket.id = $2
          RETURNING
            id, ticket_id, organization_id, author_id, author_type, body, visibility,
            created_at, external_name, external_email
        )
        SELECT
          inserted.id,
          inserted.ticket_id,
          inserted.organization_id,
          inserted.author_id,
          inserted.author_type,
          inserted.body,
          inserted.visibility,
          inserted.created_at,
          inserted.external_name,
          inserted.external_email,
          profile.full_name AS author_name
        FROM inserted
        LEFT JOIN identity.user_profiles profile
          ON profile.user_id = inserted.author_id
      `,
      [
        input.organizationId,
        input.ticketId,
        input.authorId,
        input.body,
        input.visibility,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return mapComment(row);
  }

  async createPublicComment(input: CreatePublicTicketCommentInput) {
    const ticket = await this.getByTrackingToken(input.trackingToken);
    if (!ticket) {
      return null;
    }
    const externalName =
      input.requesterName?.trim() || ticket.externalName || null;
    const externalEmail =
      input.requesterEmail?.trim().toLowerCase() ||
      ticket.requesterEmail ||
      null;
    const result = await db.query<CommentRow>(
      `
        WITH inserted AS (
          INSERT INTO tickets.ticket_comments (
            ticket_id,
            organization_id,
            author_id,
            author_type,
            body,
            visibility,
            external_name,
            external_email
          )
          VALUES ($1, $2, NULL, 'external', $3, 'public', $4, $5)
          RETURNING
            id, ticket_id, organization_id, author_id, author_type, body, visibility,
            created_at, external_name, external_email
        )
        SELECT
          inserted.*,
          inserted.external_name AS author_name
        FROM inserted
      `,
      [
        ticket.id,
        ticket.organizationId,
        input.body,
        externalName,
        externalEmail,
      ],
    );
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      await db.query(
        `
          UPDATE tickets.tickets
          SET status = 'reopened', updated_at = NOW()
          WHERE id = $1
            AND organization_id = $2
        `,
        [ticket.id, ticket.organizationId],
      );
    }
    const row = result.rows[0];
    return row ? mapComment(row) : null;
  }

  async listAttachments(organizationId: string, ticketId: string) {
    const result = await db.query<AttachmentRow>(
      `
        SELECT
          attachment.id,
          attachment.ticket_id,
          attachment.organization_id,
          attachment.uploaded_by,
          attachment.bucket,
          attachment.object_key,
          attachment.original_filename,
          attachment.content_type,
          attachment.size_bytes,
          attachment.checksum,
          attachment.created_at
        FROM tickets.ticket_attachments attachment
        JOIN tickets.tickets ticket
          ON ticket.id = attachment.ticket_id
         AND ticket.organization_id = attachment.organization_id
        WHERE attachment.organization_id = $1
          AND attachment.ticket_id = $2
        ORDER BY attachment.created_at ASC, attachment.id ASC
      `,
      [organizationId, ticketId],
    );
    return result.rows.map(mapAttachment);
  }

  async getAttachmentById(organizationId: string, attachmentId: string) {
    const result = await db.query<AttachmentRow>(
      `
        SELECT
          attachment.id,
          attachment.ticket_id,
          attachment.organization_id,
          attachment.uploaded_by,
          attachment.bucket,
          attachment.object_key,
          attachment.original_filename,
          attachment.content_type,
          attachment.size_bytes,
          attachment.checksum,
          attachment.created_at
        FROM tickets.ticket_attachments attachment
        JOIN tickets.tickets ticket
          ON ticket.id = attachment.ticket_id
         AND ticket.organization_id = attachment.organization_id
        WHERE attachment.organization_id = $1
          AND attachment.id = $2
      `,
      [organizationId, attachmentId],
    );
    return result.rows[0] ? mapAttachment(result.rows[0]) : null;
  }

  async createAttachment(input: CreateTicketAttachmentInput) {
    const result = await db.query<AttachmentRow>(
      `
        INSERT INTO tickets.ticket_attachments (
          id, ticket_id, organization_id, uploaded_by, bucket, object_key,
          original_filename, content_type, size_bytes, checksum, created_at
        )
        SELECT
          $3, ticket.id, ticket.organization_id, $4, $5, $6, $7, $8, $9, $10, NOW()
        FROM tickets.tickets ticket
        WHERE ticket.organization_id = $1
          AND ticket.id = $2
        RETURNING
          id, ticket_id, organization_id, uploaded_by, bucket, object_key,
          original_filename, content_type, size_bytes, checksum, created_at
      `,
      [
        input.organizationId,
        input.ticketId,
        input.id,
        input.uploadedBy,
        input.bucket,
        input.objectKey,
        input.originalFilename,
        input.contentType ?? null,
        input.sizeBytes ?? null,
        input.checksum ?? null,
      ],
    );
    return result.rows[0] ? mapAttachment(result.rows[0]) : null;
  }

  async deleteAttachment(organizationId: string, attachmentId: string) {
    const current = await this.getAttachmentById(organizationId, attachmentId);
    if (!current) {
      return null;
    }
    await db.query(
      `
        DELETE FROM tickets.ticket_attachments
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, attachmentId],
    );
    return current;
  }

  async listAssignableAgents(organizationId: string) {
    const result = await db.query<
      TicketAgentRecord & {
        user_id: string;
        full_name: string | null;
        office_id: string | null;
        office_name: string | null;
        office_slug: string | null;
      }
    >(
      `
        SELECT
          membership.user_id,
          profile.full_name,
          users.email,
          membership.office_id,
          office.name AS office_name,
          office.slug AS office_slug
        FROM organizations.memberships membership
        JOIN organizations.roles role
          ON role.id = membership.role_id
        JOIN identity.users users
          ON users.id = membership.user_id
        LEFT JOIN identity.user_profiles profile
          ON profile.user_id = membership.user_id
        LEFT JOIN organizations.offices office
          ON office.id = membership.office_id
        WHERE membership.organization_id = $1
          AND membership.status = 'active'
          AND (
            role.is_admin_role = TRUE
            OR role.is_manager_role = TRUE
            OR role.role_key = 'it'
          )
        ORDER BY profile.full_name NULLS LAST, users.email NULLS LAST
      `,
      [organizationId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      fullName: row.full_name,
      email: row.email,
      officeId: row.office_id,
      officeName: row.office_name,
      officeSlug: row.office_slug,
    }));
  }

  async getOrganizationMember(organizationId: string, userId: string) {
    const result = await db.query<{ user_id: string; status: string }>(
      `
        SELECT user_id, status
        FROM organizations.memberships
        WHERE organization_id = $1
          AND user_id = $2
          AND status = 'active'
      `,
      [organizationId, userId],
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id, status: row.status } : null;
  }

  async getRating(organizationId: string, ticketId: string) {
    const result = await db.query<RatingRow>(
      `
        SELECT
          id, ticket_id, organization_id, rating, feedback, created_by,
          external_email, rated_assignee_id, created_at
        FROM tickets.ticket_ratings
        WHERE organization_id = $1
          AND ticket_id = $2
      `,
      [organizationId, ticketId],
    );
    return result.rows[0] ? mapRating(result.rows[0]) : null;
  }

  async closeAndRate(input: CloseAndRateTicketInput) {
    const ticket = await this.getById(input.organizationId, input.ticketId);
    if (!ticket) {
      return null;
    }
    const ratingResult = await db.query<RatingRow>(
      `
        INSERT INTO tickets.ticket_ratings (
          ticket_id, organization_id, rating, feedback, created_by,
          external_email, rated_assignee_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (ticket_id) DO UPDATE
          SET rating = EXCLUDED.rating,
              feedback = EXCLUDED.feedback,
              created_by = COALESCE(EXCLUDED.created_by, tickets.ticket_ratings.created_by),
              external_email = COALESCE(EXCLUDED.external_email, tickets.ticket_ratings.external_email),
              rated_assignee_id = EXCLUDED.rated_assignee_id,
              created_at = NOW()
        RETURNING
          id, ticket_id, organization_id, rating, feedback, created_by,
          external_email, rated_assignee_id, created_at
      `,
      [
        ticket.id,
        ticket.organizationId,
        input.rating,
        input.feedback?.trim() || null,
        input.createdBy ?? null,
        ticket.requesterEmail,
        ticket.assignedTo,
      ],
    );
    await db.query(
      `
        UPDATE tickets.tickets
        SET
          status = 'closed',
          closed_at = COALESCE(closed_at, NOW()),
          closed_by = COALESCE(closed_by, $3),
          closed_by_email = COALESCE(closed_by_email, $4),
          updated_at = NOW()
        WHERE id = $1
          AND organization_id = $2
      `,
      [
        ticket.id,
        ticket.organizationId,
        input.closedBy,
        input.closedByEmail ?? ticket.requesterEmail,
      ],
    );
    const updated = await this.getById(ticket.organizationId, ticket.id);
    if (!updated) {
      return null;
    }
    return {
      ticket: updated,
      rating: ratingResult.rows[0] ? mapRating(ratingResult.rows[0]) : null,
    };
  }

  async closeAndRatePublic(input: ClosePublicTicketInput) {
    const ticket = await this.getByTrackingToken(input.trackingToken);
    if (!ticket) {
      return null;
    }
    return this.closeAndRate({
      organizationId: ticket.organizationId,
      ticketId: ticket.id,
      rating: input.rating,
      feedback: input.feedback,
      closedBy: null,
      closedByEmail: ticket.requesterEmail,
      createdBy: null,
    });
  }

  async getPublicOrganizationBySlug(
    slug: string,
  ): Promise<PublicTicketOrganization | null> {
    const result = await db.query<{
      id: string;
      name: string;
      slug: string;
    }>(
      `
        SELECT id, name, slug
        FROM organizations.organizations
        WHERE slug = $1
          AND is_active = TRUE
        LIMIT 1
      `,
      [slug],
    );
    return result.rows[0] ?? null;
  }

  async listPublicOffices(
    organizationId: string,
  ): Promise<PublicTicketOffice[]> {
    const result = await db.query<{
      id: string;
      name: string;
      slug: string;
    }>(
      `
        SELECT id, name, slug
        FROM organizations.offices
        WHERE organization_id = $1
          AND is_active = TRUE
        ORDER BY is_primary DESC, name ASC
      `,
      [organizationId],
    );
    return result.rows;
  }

  async getMemberOfficeSlug(organizationId: string, userId: string) {
    const result = await db.query<{ slug: string | null }>(
      `
        SELECT office.slug
        FROM organizations.memberships membership
        LEFT JOIN organizations.offices office
          ON office.id = membership.office_id
        WHERE membership.organization_id = $1
          AND membership.user_id = $2
          AND membership.status = 'active'
        LIMIT 1
      `,
      [organizationId, userId],
    );
    return result.rows[0]?.slug ?? null;
  }

  private async closeStaleWorkSessions(ticketId?: string | null) {
    await db.query(
      `
        UPDATE tickets.ticket_time_sessions
        SET ended_at = last_heartbeat_at
        WHERE ended_at IS NULL
          AND last_heartbeat_at < NOW() - INTERVAL '150 seconds'
          AND ($1::uuid IS NULL OR ticket_id = $1)
      `,
      [ticketId ?? null],
    );
  }

  private async trackedSeconds(ticketId: string) {
    const result = await db.query<{ seconds: string | number | null }>(
      `
        SELECT COALESCE(
          FLOOR(
            SUM(
              EXTRACT(
                EPOCH FROM (
                  COALESCE(ended_at, last_heartbeat_at) - started_at
                )
              )
            )
          )::integer,
          0
        ) AS seconds
        FROM tickets.ticket_time_sessions
        WHERE ticket_id = $1
      `,
      [ticketId],
    );
    return Math.max(0, Number(result.rows[0]?.seconds ?? 0));
  }

  private async refreshWorkEstimate(ticketId: string) {
    const ticket = await db.query<{
      organization_id: string;
      category: string;
    }>(
      `
        SELECT organization_id, lower(btrim(category)) AS category
        FROM tickets.tickets
        WHERE id = $1
      `,
      [ticketId],
    );
    const row = ticket.rows[0];
    if (!row) return;

    const samples = await db.query<{ minutes: string | number }>(
      `
        SELECT
          (
            SELECT COALESCE(
              FLOOR(
                SUM(
                  EXTRACT(
                    EPOCH FROM (
                      COALESCE(s.ended_at, s.last_heartbeat_at) - s.started_at
                    )
                  )
                )
              )::numeric / 60.0,
              0
            )
            FROM tickets.ticket_time_sessions s
            WHERE s.ticket_id = t.id
          ) AS minutes
        FROM tickets.tickets t
        WHERE t.organization_id = $1
          AND t.id <> $2
          AND t.status IN ('resolved', 'closed')
          AND lower(btrim(t.category)) = $3
      `,
      [row.organization_id, ticketId, row.category],
    );
    const minutes = samples.rows
      .map((sample) => Number(sample.minutes))
      .filter((value) => Number.isFinite(value) && value >= 1)
      .sort((a, b) => a - b);
    const sampleCount = minutes.length;
    const confidence = estimateConfidence(sampleCount);
    const low = percentile(minutes, 0.2);
    const median = percentile(minutes, 0.5);
    const high = percentile(minutes, 0.8);
    await db.query(
      `
        INSERT INTO tickets.ticket_work_estimates (
          ticket_id, organization_id, minutes_low, minutes_median, minutes_high,
          sample_count, confidence, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (ticket_id) DO UPDATE
          SET organization_id = EXCLUDED.organization_id,
              minutes_low = EXCLUDED.minutes_low,
              minutes_median = EXCLUDED.minutes_median,
              minutes_high = EXCLUDED.minutes_high,
              sample_count = EXCLUDED.sample_count,
              confidence = EXCLUDED.confidence,
              updated_at = NOW()
      `,
      [
        ticketId,
        row.organization_id,
        low == null ? null : Math.max(1, Math.round(low)),
        median == null ? null : Math.max(1, Math.round(median)),
        high == null ? null : Math.max(1, Math.round(high)),
        sampleCount,
        confidence,
      ],
    );
  }

  private async workIntelligencePayload(
    ticketId: string,
  ): Promise<TicketWorkIntelligenceRecord> {
    const ticket = await db.query<{ status: TicketStatus }>(
      `SELECT status FROM tickets.tickets WHERE id = $1`,
      [ticketId],
    );
    if (!ticket.rows[0]) {
      return {
        allowed: true,
        trackedSeconds: 0,
        running: false,
        clockState: 'idle',
        lastHeartbeatAt: null,
        minutesLow: null,
        minutesMedian: null,
        minutesHigh: null,
        sampleCount: 0,
        confidence: 'none',
        error: 'not_found',
      };
    }
    const estimate = await db.query<{
      minutes_low: number | null;
      minutes_median: number | null;
      minutes_high: number | null;
      sample_count: number;
      confidence: string;
    }>(
      `
        SELECT minutes_low, minutes_median, minutes_high, sample_count, confidence
        FROM tickets.ticket_work_estimates
        WHERE ticket_id = $1
      `,
      [ticketId],
    );
    const session = await db.query<{
      running: boolean;
      last_heartbeat_at: Date | null;
    }>(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM tickets.ticket_time_sessions s
            WHERE s.ticket_id = $1
              AND s.ended_at IS NULL
              AND s.last_heartbeat_at >= NOW() - INTERVAL '150 seconds'
          ) AS running,
          (
            SELECT max(s.last_heartbeat_at)
            FROM tickets.ticket_time_sessions s
            WHERE s.ticket_id = $1
              AND s.ended_at IS NULL
          ) AS last_heartbeat_at
      `,
      [ticketId],
    );
    const running = Boolean(session.rows[0]?.running);
    const status = ticket.rows[0].status;
    let clockState: TicketWorkClockState = 'idle';
    if (running) clockState = 'running';
    else if (
      status === 'waiting_for_requester' ||
      status === 'waiting_for_third_party'
    ) {
      clockState = 'paused';
    } else if (status === 'resolved' || status === 'closed') {
      clockState = 'stopped';
    }
    const confidenceRaw = estimate.rows[0]?.confidence ?? 'none';
    const confidence =
      confidenceRaw === 'low' ||
      confidenceRaw === 'medium' ||
      confidenceRaw === 'high'
        ? confidenceRaw
        : 'none';
    return {
      allowed: true,
      ticketId,
      trackedSeconds: await this.trackedSeconds(ticketId),
      running,
      clockState,
      lastHeartbeatAt: session.rows[0]?.last_heartbeat_at
        ? session.rows[0].last_heartbeat_at.toISOString()
        : null,
      minutesLow: estimate.rows[0]?.minutes_low ?? null,
      minutesMedian: estimate.rows[0]?.minutes_median ?? null,
      minutesHigh: estimate.rows[0]?.minutes_high ?? null,
      sampleCount: estimate.rows[0]?.sample_count ?? 0,
      confidence,
    };
  }

  async getWorkIntelligence(organizationId: string, ticketIds: string[]) {
    const ids = [...new Set(ticketIds.filter(Boolean))];
    if (ids.length === 0) return [];
    await this.closeStaleWorkSessions(null);
    const rows: TicketWorkIntelligenceRecord[] = [];
    for (const ticketId of ids) {
      const ticket = await this.getById(organizationId, ticketId);
      if (!ticket) continue;
      const estimate = await db.query(
        `SELECT 1 FROM tickets.ticket_work_estimates WHERE ticket_id = $1`,
        [ticketId],
      );
      if (!estimate.rows[0]) {
        await this.refreshWorkEstimate(ticketId);
      }
      rows.push(await this.workIntelligencePayload(ticketId));
    }
    return rows;
  }

  async heartbeatWork(
    organizationId: string,
    ticketId: string,
    userId: string,
  ) {
    const ticket = await this.getById(organizationId, ticketId);
    if (!ticket) return null;
    await this.closeStaleWorkSessions(ticketId);
    const active =
      ticket.assignedTo === userId &&
      ['open', 'assigned', 'in_progress', 'reopened'].includes(ticket.status);
    let clockState: TicketWorkClockState = 'stopped';
    if (active) {
      const open = await db.query<{ id: string }>(
        `
          SELECT id
          FROM tickets.ticket_time_sessions
          WHERE ticket_id = $1
            AND user_id = $2
            AND ended_at IS NULL
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [ticketId, userId],
      );
      if (open.rows[0]) {
        await db.query(
          `
            UPDATE tickets.ticket_time_sessions
            SET last_heartbeat_at = NOW()
            WHERE id = $1
          `,
          [open.rows[0].id],
        );
      } else {
        await db.query(
          `
            INSERT INTO tickets.ticket_time_sessions (
              ticket_id, organization_id, user_id, started_at, last_heartbeat_at, source
            ) VALUES ($1, $2, $3, NOW(), NOW(), 'focus')
          `,
          [ticketId, organizationId, userId],
        );
      }
      clockState = 'running';
    } else {
      await db.query(
        `
          UPDATE tickets.ticket_time_sessions
          SET ended_at = last_heartbeat_at
          WHERE ticket_id = $1
            AND user_id = $2
            AND ended_at IS NULL
        `,
        [ticketId, userId],
      );
      if (
        ticket.status === 'waiting_for_requester' ||
        ticket.status === 'waiting_for_third_party'
      ) {
        clockState = 'paused';
      } else if (ticket.assignedTo !== userId) {
        clockState = 'idle';
      } else {
        clockState = 'stopped';
      }
    }
    const estimate = await db.query(
      `SELECT 1 FROM tickets.ticket_work_estimates WHERE ticket_id = $1`,
      [ticketId],
    );
    if (!estimate.rows[0]) {
      await this.refreshWorkEstimate(ticketId);
    }
    const payload = await this.workIntelligencePayload(ticketId);
    return { ...payload, clockState };
  }

  async stopWork(organizationId: string, ticketId: string, userId: string) {
    const ticket = await this.getById(organizationId, ticketId);
    if (!ticket) return null;
    await db.query(
      `
        UPDATE tickets.ticket_time_sessions
        SET ended_at = last_heartbeat_at
        WHERE ticket_id = $1
          AND user_id = $2
          AND ended_at IS NULL
      `,
      [ticketId, userId],
    );
    const estimate = await db.query(
      `SELECT 1 FROM tickets.ticket_work_estimates WHERE ticket_id = $1`,
      [ticketId],
    );
    if (!estimate.rows[0]) {
      await this.refreshWorkEstimate(ticketId);
    }
    return this.workIntelligencePayload(ticketId);
  }

  async listMonthlyReportTickets(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<MonthlyTicketReportTicket[]> {
    const result = await db.query<{
      id: string;
      ticket_number: string;
      subject: string;
      status: TicketStatus;
      priority: TicketPriority;
      category: string;
      assigned_to: string | null;
      assigned_name: string | null;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `
        SELECT
          ticket.id,
          ticket.ticket_number,
          ticket.subject,
          ticket.status,
          ticket.priority,
          ticket.category,
          ticket.assigned_to,
          profile.full_name AS assigned_name,
          ticket.created_at,
          ticket.resolved_at
        FROM tickets.tickets ticket
        LEFT JOIN identity.user_profiles profile
          ON profile.user_id = ticket.assigned_to
        WHERE ticket.organization_id = $1
          AND ticket.created_at >= $2
          AND ticket.created_at < $3
        ORDER BY ticket.created_at ASC
      `,
      [organizationId, from, to],
    );
    return result.rows.map((row) => ({
      id: row.id,
      ticketNumber: row.ticket_number,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      category: row.category,
      assignedTo: row.assigned_to,
      assignedName: row.assigned_name,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
  }

  async listMonthlyReportRecipients(
    organizationId: string,
  ): Promise<MonthlyTicketReportRecipient[]> {
    const roles = [...MONTHLY_REPORT_ADMIN_ROLES];
    const result = await db.query<{
      user_id: string;
      full_name: string | null;
      email: string;
      role_key: string | null;
    }>(
      `
        SELECT
          membership.user_id,
          profile.full_name,
          users.email,
          role.role_key
        FROM organizations.memberships membership
        JOIN organizations.roles role
          ON role.id = membership.role_id
        JOIN identity.users users
          ON users.id = membership.user_id
        LEFT JOIN identity.user_profiles profile
          ON profile.user_id = membership.user_id
        WHERE membership.organization_id = $1
          AND membership.status = 'active'
          AND users.email IS NOT NULL
          AND (
            role.is_admin_role = TRUE
            OR role.role_key = ANY($2::text[])
          )
        ORDER BY profile.full_name NULLS LAST, users.email
      `,
      [organizationId, roles],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      fullName: row.full_name,
      email: row.email,
      roleKey: row.role_key,
    }));
  }
}
