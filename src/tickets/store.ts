export const TICKET_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'waiting_for_requester',
  'waiting_for_third_party',
  'resolved',
  'closed',
  'reopened',
] as const;

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const TICKET_ACTION_TAKEN_MIN_CHARS = 20;

export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketCommentVisibility = 'public' | 'internal';

export type TicketRecord = {
  id: string;
  organizationId: string;
  officeId: string | null;
  linkedCardId: string | null;
  ticketNumber: string;
  requesterType: 'internal' | 'external';
  userId: string | null;
  createdBy: string | null;
  assignedTo: string | null;
  requesterEmail: string | null;
  category: string;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  actionTaken: string | null;
  archivedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  closedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  requesterName: string | null;
  assignedName: string | null;
  officeName: string | null;
  organizationName: string | null;
};

export type TicketCommentRecord = {
  id: string;
  ticketId: string;
  organizationId: string;
  authorId: string | null;
  authorType: 'internal' | 'external';
  body: string;
  visibility: TicketCommentVisibility;
  createdAt: Date;
  authorName: string | null;
};

export type TicketAgentRecord = {
  userId: string;
  fullName: string | null;
  email: string | null;
  officeId: string | null;
  officeName: string | null;
  officeSlug: string | null;
};

export type ListTicketsInput = {
  organizationId: string;
  requesterUserId?: string | null;
  assignedTo?: string | null;
  statuses?: TicketStatus[];
  priorities?: TicketPriority[];
  search?: string | null;
  includeArchived?: boolean;
  limit?: number;
};

export type CreateTicketInput = {
  organizationId: string;
  officeId?: string | null;
  userId: string;
  createdBy: string;
  requesterEmail?: string | null;
  category: string;
  subject: string;
  description: string;
  priority?: TicketPriority;
  assignedTo?: string | null;
};

export type UpdateTicketInput = {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: string;
  subject?: string;
  description?: string;
  actionTaken?: string | null;
  assignedTo?: string | null;
  linkedCardId?: string | null;
};

export type CreateTicketCommentInput = {
  organizationId: string;
  ticketId: string;
  authorId: string;
  body: string;
  visibility: TicketCommentVisibility;
};

export type TicketAttachmentRecord = {
  id: string;
  ticketId: string;
  organizationId: string;
  uploadedBy: string | null;
  bucket: string;
  objectKey: string;
  originalFilename: string;
  contentType: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  createdAt: Date;
};

export type CreateTicketAttachmentInput = {
  id: string;
  organizationId: string;
  ticketId: string;
  uploadedBy: string;
  bucket: string;
  objectKey: string;
  originalFilename: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  checksum?: string | null;
};

export function ticketAttachmentObjectKey(
  organizationId: string,
  ticketId: string,
  attachmentId: string,
  filename: string,
) {
  return `${organizationId}/tickets/${ticketId}/attachments/${attachmentId}/${filename}`;
}

export interface TicketStore {
  list(input: ListTicketsInput): Promise<TicketRecord[]>;
  getById(organizationId: string, ticketId: string): Promise<TicketRecord | null>;
  getByCardId(organizationId: string, cardId: string): Promise<TicketRecord | null>;
  create(input: CreateTicketInput): Promise<TicketRecord>;
  update(
    organizationId: string,
    ticketId: string,
    input: UpdateTicketInput,
    actorUserId: string,
  ): Promise<TicketRecord | null>;
  listComments(
    organizationId: string,
    ticketId: string,
  ): Promise<TicketCommentRecord[]>;
  createComment(
    input: CreateTicketCommentInput,
  ): Promise<TicketCommentRecord | null>;
  listAttachments(
    organizationId: string,
    ticketId: string,
  ): Promise<TicketAttachmentRecord[]>;
  getAttachmentById(
    organizationId: string,
    attachmentId: string,
  ): Promise<TicketAttachmentRecord | null>;
  createAttachment(
    input: CreateTicketAttachmentInput,
  ): Promise<TicketAttachmentRecord | null>;
  deleteAttachment(
    organizationId: string,
    attachmentId: string,
  ): Promise<TicketAttachmentRecord | null>;
  listAssignableAgents(organizationId: string): Promise<TicketAgentRecord[]>;
  getOrganizationMember(
    organizationId: string,
    userId: string,
  ): Promise<{ userId: string; status: string } | null>;
}
