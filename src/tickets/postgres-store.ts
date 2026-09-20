import { db } from '../db/pool.js';
import type {
  CreateTicketAttachmentInput,
  CreateTicketCommentInput,
  CreateTicketInput,
  ListTicketsInput,
  TicketAgentRecord,
  TicketAttachmentRecord,
  TicketCommentRecord,
  TicketPriority,
  TicketRecord,
  TicketStatus,
  TicketStore,
  UpdateTicketInput,
} from './store.js';

type TicketRow = {
  id: string;
  organization_id: string;
  office_id: string | null;
  linked_card_id: string | null;
  ticket_number: string;
  requester_type: 'internal' | 'external';
  user_id: string | null;
  created_by: string | null;
  assigned_to: string | null;
  requester_email: string | null;
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
  ticket.requester_type,
  ticket.user_id,
  ticket.created_by,
  ticket.assigned_to,
  ticket.requester_email,
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
  ticket.created_at,
  ticket.updated_at,
  requester_profile.full_name AS requester_name,
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
    requesterType: row.requester_type,
    userId: row.user_id,
    createdBy: row.created_by,
    assignedTo: row.assigned_to,
    requesterEmail: row.requester_email,
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
    authorName: row.author_name ?? null,
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
          ticket_number
        )
        SELECT
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          CASE WHEN $5::uuid IS NULL THEN 'open' ELSE 'assigned' END,
          numbered.prefix || '-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(numbered.seq::text, 5, '0')
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
          profile.full_name AS author_name
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
            id, ticket_id, organization_id, author_id, author_type, body, visibility, created_at
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
}
