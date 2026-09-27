import { randomUUID } from 'node:crypto';
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
  TicketRatingRecord,
  TicketRecord,
  TicketStore,
  TicketWorkIntelligenceRecord,
  UpdateTicketInput,
} from './store.js';

function cloneTicket(ticket: TicketRecord): TicketRecord {
  return { ...ticket };
}

export class MemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly comments = new Map<string, TicketCommentRecord>();
  private readonly attachments = new Map<string, TicketAttachmentRecord>();
  private readonly ratings = new Map<string, TicketRatingRecord>();
  private readonly members = new Map<string, { userId: string; status: string }>();
  private readonly memberOffices = new Map<string, string | null>();
  private readonly agents: TicketAgentRecord[] = [];
  private readonly displayNames = new Map<string, string>();
  private readonly organizations = new Map<
    string,
    PublicTicketOrganization
  >();
  private readonly offices = new Map<string, PublicTicketOffice[]>();
  private readonly workSessions = new Map<
    string,
    Array<{
      id: string;
      ticketId: string;
      organizationId: string;
      userId: string;
      startedAt: Date;
      lastHeartbeatAt: Date;
      endedAt: Date | null;
    }>
  >();
  private readonly reportRecipients: MonthlyTicketReportRecipient[] = [];
  private sequence = 0;
  organizationName = 'Organization';

  seedMember(organizationId: string, userId: string, status = 'active') {
    this.members.set(`${organizationId}:${userId}`, { userId, status });
  }

  seedMemberOffice(
    organizationId: string,
    userId: string,
    officeSlug: string | null,
  ) {
    this.memberOffices.set(`${organizationId}:${userId}`, officeSlug);
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

  seedOrganization(org: PublicTicketOrganization) {
    this.organizations.set(org.slug, org);
  }

  seedOffices(organizationId: string, offices: PublicTicketOffice[]) {
    this.offices.set(organizationId, offices);
  }

  seedReportRecipient(recipient: MonthlyTicketReportRecipient) {
    this.reportRecipients.push(recipient);
  }

  private hydrate(ticket: TicketRecord): TicketRecord {
    return {
      ...ticket,
      requesterName:
        ticket.requesterName ??
        (ticket.userId
          ? this.displayNames.get(ticket.userId) ?? null
          : ticket.externalName),
      assignedName: ticket.assignedTo
        ? this.displayNames.get(ticket.assignedTo) ?? null
        : null,
      organizationName: this.organizationName,
    };
  }

  private emptyIntel(
    ticketId?: string,
    allowed = true,
  ): TicketWorkIntelligenceRecord {
    return {
      allowed,
      ticketId,
      trackedSeconds: 0,
      running: false,
      clockState: 'idle',
      lastHeartbeatAt: null,
      minutesLow: null,
      minutesMedian: null,
      minutesHigh: null,
      sampleCount: 0,
      confidence: 'none',
    };
  }

  private trackedSeconds(ticketId: string) {
    const sessions = this.workSessions.get(ticketId) ?? [];
    return sessions.reduce((total, session) => {
      const end = session.endedAt ?? session.lastHeartbeatAt;
      return (
        total +
        Math.max(
          0,
          Math.floor((end.getTime() - session.startedAt.getTime()) / 1000),
        )
      );
    }, 0);
  }

  private payloadFor(ticket: TicketRecord): TicketWorkIntelligenceRecord {
    const sessions = this.workSessions.get(ticket.id) ?? [];
    const open = sessions.find(
      (session) =>
        session.endedAt == null &&
        Date.now() - session.lastHeartbeatAt.getTime() < 150_000,
    );
    let clockState: TicketWorkIntelligenceRecord['clockState'] = 'idle';
    if (open) clockState = 'running';
    else if (
      ticket.status === 'waiting_for_requester' ||
      ticket.status === 'waiting_for_third_party'
    ) {
      clockState = 'paused';
    } else if (ticket.status === 'resolved' || ticket.status === 'closed') {
      clockState = 'stopped';
    }
    return {
      allowed: true,
      ticketId: ticket.id,
      trackedSeconds: this.trackedSeconds(ticket.id),
      running: Boolean(open),
      clockState,
      lastHeartbeatAt: open ? open.lastHeartbeatAt.toISOString() : null,
      minutesLow: null,
      minutesMedian: null,
      minutesHigh: null,
      sampleCount: 0,
      confidence: 'none',
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
          const haystack =
            `${ticket.ticketNumber} ${ticket.subject} ${ticket.description}`.toLowerCase();
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

  async getByTrackingToken(trackingToken: string) {
    const ticket = [...this.tickets.values()].find(
      (row) => row.trackingToken === trackingToken,
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
      trackingToken: randomUUID(),
      requesterType: 'internal',
      userId: input.userId,
      createdBy: input.createdBy,
      assignedTo,
      requesterEmail: input.requesterEmail ?? null,
      externalName: null,
      externalCompany: null,
      externalPhone: null,
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
      closedByEmail: null,
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

  async createPublic(input: CreatePublicTicketInput) {
    this.sequence += 1;
    const now = new Date();
    const ticket: TicketRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      officeId: input.officeId,
      linkedCardId: null,
      ticketNumber: `SD-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${String(this.sequence).padStart(5, '0')}`,
      trackingToken: randomUUID(),
      requesterType: 'external',
      userId: null,
      createdBy: null,
      assignedTo: null,
      requesterEmail: input.requesterEmail.toLowerCase(),
      externalName: input.externalName,
      externalCompany: input.externalCompany ?? null,
      externalPhone: input.externalPhone ?? null,
      category: input.category,
      subject: input.subject,
      description: input.description,
      status: 'open',
      priority: input.priority ?? 'medium',
      actionTaken: null,
      archivedAt: null,
      resolvedAt: null,
      closedAt: null,
      closedBy: null,
      closedByEmail: null,
      createdAt: now,
      updatedAt: now,
      requesterName: input.externalName,
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
        authorName:
          comment.authorName ??
          (comment.authorId
            ? this.displayNames.get(comment.authorId) ?? null
            : comment.externalName),
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
      externalName: null,
      externalEmail: null,
    };
    this.comments.set(comment.id, comment);
    return { ...comment };
  }

  async createPublicComment(input: CreatePublicTicketCommentInput) {
    const ticket = await this.getByTrackingToken(input.trackingToken);
    if (!ticket) return null;
    const comment: TicketCommentRecord = {
      id: randomUUID(),
      ticketId: ticket.id,
      organizationId: ticket.organizationId,
      authorId: null,
      authorType: 'external',
      body: input.body,
      visibility: 'public',
      createdAt: new Date(),
      authorName: input.requesterName ?? ticket.externalName,
      externalName: input.requesterName ?? ticket.externalName,
      externalEmail: input.requesterEmail ?? ticket.requesterEmail,
    };
    this.comments.set(comment.id, comment);
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      ticket.status = 'reopened';
      ticket.updatedAt = new Date();
    }
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

  async getRating(organizationId: string, ticketId: string) {
    const rating = this.ratings.get(ticketId);
    if (!rating || rating.organizationId !== organizationId) return null;
    return { ...rating };
  }

  async closeAndRate(input: CloseAndRateTicketInput) {
    const ticket = this.tickets.get(input.ticketId);
    if (!ticket || ticket.organizationId !== input.organizationId) {
      return null;
    }
    const existing = this.ratings.get(ticket.id);
    const rating: TicketRatingRecord = {
      id: existing?.id ?? randomUUID(),
      ticketId: ticket.id,
      organizationId: ticket.organizationId,
      rating: input.rating,
      feedback: input.feedback?.trim() || null,
      createdBy: input.createdBy ?? existing?.createdBy ?? null,
      externalEmail: ticket.requesterEmail ?? existing?.externalEmail ?? null,
      ratedAssigneeId: ticket.assignedTo,
      createdAt: new Date(),
    };
    this.ratings.set(ticket.id, rating);
    ticket.status = 'closed';
    ticket.closedAt = ticket.closedAt ?? new Date();
    ticket.closedBy = ticket.closedBy ?? input.closedBy;
    ticket.closedByEmail =
      ticket.closedByEmail ?? input.closedByEmail ?? ticket.requesterEmail;
    ticket.updatedAt = new Date();
    return { ticket: this.hydrate(ticket), rating: { ...rating } };
  }

  async closeAndRatePublic(input: ClosePublicTicketInput) {
    const ticket = await this.getByTrackingToken(input.trackingToken);
    if (!ticket) return null;
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

  async getPublicOrganizationBySlug(slug: string) {
    return this.organizations.get(slug) ?? null;
  }

  async listPublicOffices(organizationId: string) {
    return [...(this.offices.get(organizationId) ?? [])];
  }

  async getMemberOfficeSlug(organizationId: string, userId: string) {
    return this.memberOffices.get(`${organizationId}:${userId}`) ?? null;
  }

  async getWorkIntelligence(organizationId: string, ticketIds: string[]) {
    return ticketIds
      .map((ticketId) => this.tickets.get(ticketId))
      .filter(
        (ticket): ticket is TicketRecord =>
          Boolean(ticket) && ticket!.organizationId === organizationId,
      )
      .map((ticket) => this.payloadFor(ticket));
  }

  async heartbeatWork(
    organizationId: string,
    ticketId: string,
    userId: string,
  ) {
    const ticket = await this.getById(organizationId, ticketId);
    if (!ticket) return null;
    const sessions = this.workSessions.get(ticketId) ?? [];
    const active =
      ticket.assignedTo === userId &&
      ['open', 'assigned', 'in_progress', 'reopened'].includes(ticket.status);
    if (active) {
      const open = sessions.find(
        (session) => session.userId === userId && session.endedAt == null,
      );
      if (open) {
        open.lastHeartbeatAt = new Date();
      } else {
        sessions.push({
          id: randomUUID(),
          ticketId,
          organizationId,
          userId,
          startedAt: new Date(),
          lastHeartbeatAt: new Date(),
          endedAt: null,
        });
      }
    } else {
      for (const session of sessions) {
        if (session.userId === userId && session.endedAt == null) {
          session.endedAt = session.lastHeartbeatAt;
        }
      }
    }
    this.workSessions.set(ticketId, sessions);
    return this.payloadFor(ticket);
  }

  async stopWork(organizationId: string, ticketId: string, userId: string) {
    const ticket = await this.getById(organizationId, ticketId);
    if (!ticket) return null;
    const sessions = this.workSessions.get(ticketId) ?? [];
    for (const session of sessions) {
      if (session.userId === userId && session.endedAt == null) {
        session.endedAt = session.lastHeartbeatAt;
      }
    }
    this.workSessions.set(ticketId, sessions);
    return this.payloadFor(ticket);
  }

  async listMonthlyReportTickets(
    organizationId: string,
    from: Date,
    to: Date,
  ): Promise<MonthlyTicketReportTicket[]> {
    return [...this.tickets.values()]
      .filter(
        (ticket) =>
          ticket.organizationId === organizationId &&
          ticket.createdAt >= from &&
          ticket.createdAt < to,
      )
      .map((ticket) => ({
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        assignedTo: ticket.assignedTo,
        assignedName: ticket.assignedTo
          ? this.displayNames.get(ticket.assignedTo) ?? null
          : null,
        createdAt: ticket.createdAt,
        resolvedAt: ticket.resolvedAt,
      }));
  }

  async listMonthlyReportRecipients(organizationId: string) {
    void organizationId;
    return this.reportRecipients.map((row) => ({ ...row }));
  }

  async listAssignableAgents(organizationId: string) {
    void organizationId;
    return this.agents.map((agent) => ({ ...agent }));
  }

  async getOrganizationMember(organizationId: string, userId: string) {
    return this.members.get(`${organizationId}:${userId}`) ?? null;
  }
}
