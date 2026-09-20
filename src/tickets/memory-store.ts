import { randomUUID } from 'node:crypto';
import type {
  CreateTicketAttachmentInput,
  CreateTicketCommentInput,
  CreateTicketInput,
  ListTicketsInput,
  TicketAgentRecord,
  TicketAttachmentRecord,
  TicketCommentRecord,
  TicketRecord,
  TicketStore,
  UpdateTicketInput,
} from './store.js';

function cloneTicket(ticket: TicketRecord): TicketRecord {
  return { ...ticket };
}

export class MemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly comments = new Map<string, TicketCommentRecord>();
  private readonly attachments = new Map<string, TicketAttachmentRecord>();
  private readonly members = new Map<string, { userId: string; status: string }>();
  private readonly agents: TicketAgentRecord[] = [];
  private readonly displayNames = new Map<string, string>();
  private sequence = 0;
  organizationName = 'Organization';

  seedMember(organizationId: string, userId: string, status = 'active') {
    this.members.set(`${organizationId}:${userId}`, { userId, status });
  }

  seedAgent(agent: TicketAgentRecord) {
    this.agents.push(agent);
  }

  seedDisplayName(userId: string, name: string) {
    this.displayNames.set(userId, name);
  }

  seedLinkedCard(organizationId: string, cardId: string, ticketId: string) {
    const ticket = this.tickets.get(ticketId);
    if (ticket && ticket.organizationId === organizationId) {
      ticket.linkedCardId = cardId;
    }
  }

  private hydrate(ticket: TicketRecord): TicketRecord {
    return {
      ...ticket,
      requesterName: ticket.userId
        ? this.displayNames.get(ticket.userId) ?? null
        : null,
      assignedName: ticket.assignedTo
        ? this.displayNames.get(ticket.assignedTo) ?? null
        : null,
      organizationName: this.organizationName,
    };
  }

  async list(input: ListTicketsInput) {
    const limit = input.limit ?? 200;
    return [...this.tickets.values()]
      .filter((ticket) => {
        if (ticket.organizationId !== input.organizationId) return false;
        if (!input.includeArchived && ticket.archivedAt) return false;
        if (input.requesterUserId && ticket.userId !== input.requesterUserId) {
          return false;
        }
        if (input.assignedTo && ticket.assignedTo !== input.assignedTo) {
          return false;
        }
        if (input.statuses?.length && !input.statuses.includes(ticket.status)) {
          return false;
        }
        if (
          input.priorities?.length &&
          !input.priorities.includes(ticket.priority)
        ) {
          return false;
        }
        if (input.search?.trim()) {
          const needle = input.search.trim().toLowerCase();
          const haystack = `${ticket.ticketNumber} ${ticket.subject} ${ticket.description}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit)
      .map((ticket) => this.hydrate(ticket));
  }

  async getById(organizationId: string, ticketId: string) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.organizationId !== organizationId) {
      return null;
    }
    return this.hydrate(ticket);
  }

  async getByCardId(organizationId: string, cardId: string) {
    const ticket = [...this.tickets.values()].find(
      (row) =>
        row.organizationId === organizationId && row.linkedCardId === cardId,
    );
    return ticket ? this.hydrate(ticket) : null;
  }

  async create(input: CreateTicketInput) {
    this.sequence += 1;
    const now = new Date();
    const assignedTo = input.assignedTo ?? null;
    const ticket: TicketRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      officeId: input.officeId ?? null,
      linkedCardId: null,
      ticketNumber: `SD-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${String(this.sequence).padStart(5, '0')}`,
      requesterType: 'internal',
      userId: input.userId,
      createdBy: input.createdBy,
      assignedTo,
      requesterEmail: input.requesterEmail ?? null,
      category: input.category,
      subject: input.subject,
      description: input.description,
      status: assignedTo ? 'assigned' : 'open',
      priority: input.priority ?? 'medium',
      actionTaken: null,
      archivedAt: null,
      resolvedAt: null,
      closedAt: null,
      closedBy: null,
      createdAt: now,
      updatedAt: now,
      requesterName: null,
      assignedName: null,
      officeName: null,
      organizationName: this.organizationName,
    };
    this.tickets.set(ticket.id, ticket);
    return this.hydrate(ticket);
  }

  async update(
    organizationId: string,
    ticketId: string,
    input: UpdateTicketInput,
    actorUserId: string,
  ) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.organizationId !== organizationId) {
      return null;
    }
    if (input.status !== undefined) ticket.status = input.status;
    if (input.priority !== undefined) ticket.priority = input.priority;
    if (input.category !== undefined) ticket.category = input.category;
    if (input.subject !== undefined) ticket.subject = input.subject;
    if (input.description !== undefined) ticket.description = input.description;
    if (input.actionTaken !== undefined) ticket.actionTaken = input.actionTaken;
    if (input.assignedTo !== undefined) {
      ticket.assignedTo = input.assignedTo;
      if (input.assignedTo && ticket.status === 'open') {
        ticket.status = 'assigned';
      }
      if (input.assignedTo === null && ticket.status === 'assigned') {
        ticket.status = 'open';
      }
    }
    if (input.linkedCardId !== undefined) ticket.linkedCardId = input.linkedCardId;
    if (ticket.status === 'resolved' && !ticket.resolvedAt) {
      ticket.resolvedAt = new Date();
    }
    if (ticket.status === 'closed' && !ticket.closedAt) {
      ticket.closedAt = new Date();
      ticket.closedBy = actorUserId;
    }
    ticket.updatedAt = new Date();
    return this.hydrate(ticket);
  }

  async listComments(organizationId: string, ticketId: string) {
    return [...this.comments.values()]
      .filter(
        (comment) =>
          comment.organizationId === organizationId &&
          comment.ticketId === ticketId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((comment) => ({
        ...comment,
        authorName: comment.authorId
          ? this.displayNames.get(comment.authorId) ?? null
          : null,
      }));
  }

  async createComment(input: CreateTicketCommentInput) {
    const ticket = await this.getById(input.organizationId, input.ticketId);
    if (!ticket) {
      return null;
    }
    const comment: TicketCommentRecord = {
      id: randomUUID(),
      ticketId: input.ticketId,
      organizationId: input.organizationId,
      authorId: input.authorId,
      authorType: 'internal',
      body: input.body,
      visibility: input.visibility,
      createdAt: new Date(),
      authorName: this.displayNames.get(input.authorId) ?? null,
    };
    this.comments.set(comment.id, comment);
    return { ...comment };
  }

  async listAttachments(organizationId: string, ticketId: string) {
    return [...this.attachments.values()]
      .filter(
        (attachment) =>
          attachment.organizationId === organizationId &&
          attachment.ticketId === ticketId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((attachment) => ({ ...attachment }));
  }

  async getAttachmentById(organizationId: string, attachmentId: string) {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment || attachment.organizationId !== organizationId) {
      return null;
    }
    return { ...attachment };
  }

  async createAttachment(input: CreateTicketAttachmentInput) {
    const ticket = await this.getById(input.organizationId, input.ticketId);
    if (!ticket) {
      return null;
    }
    const attachment: TicketAttachmentRecord = {
      id: input.id,
      ticketId: input.ticketId,
      organizationId: input.organizationId,
      uploadedBy: input.uploadedBy,
      bucket: input.bucket,
      objectKey: input.objectKey,
      originalFilename: input.originalFilename,
      contentType: input.contentType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      checksum: input.checksum ?? null,
      createdAt: new Date(),
    };
    this.attachments.set(attachment.id, attachment);
    return { ...attachment };
  }

  async deleteAttachment(organizationId: string, attachmentId: string) {
    const current = await this.getAttachmentById(organizationId, attachmentId);
    if (!current) {
      return null;
    }
    this.attachments.delete(attachmentId);
    return current;
  }

  async listAssignableAgents(organizationId: string) {
    void organizationId;
    return this.agents.map((agent) => ({ ...agent }));
  }

  async getOrganizationMember(organizationId: string, userId: string) {
    return this.members.get(`${organizationId}:${userId}`) ?? null;
  }
}
