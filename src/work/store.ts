export type BoardRecord = {
  id: string;
  organizationId: string;
  createdBy: string;
  ownerId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  status: string;
  color: string | null;
  position: number;
  metadata: unknown;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateBoardInput = {
  organizationId: string;
  createdBy: string;
  ownerId?: string | null;
  name: string;
  slug?: string | null;
  description?: string | null;
  status?: string;
  color?: string | null;
  position?: number;
  metadata?: Record<string, unknown>;
};

export type UpdateBoardInput = {
  name?: string;
  slug?: string | null;
  description?: string | null;
  status?: string;
  color?: string | null;
  position?: number;
  metadata?: Record<string, unknown>;
  ownerId?: string | null;
};

export interface BoardStore {
  listByOrganization(organizationId: string): Promise<BoardRecord[]>;
  getById(
    organizationId: string,
    boardId: string,
  ): Promise<BoardRecord | null>;
  create(input: CreateBoardInput): Promise<BoardRecord>;
  update(
    organizationId: string,
    boardId: string,
    input: UpdateBoardInput,
  ): Promise<BoardRecord | null>;
}

export type ColumnRecord = {
  id: string;
  organizationId: string;
  boardId: string;
  name: string;
  color: string | null;
  statusKey: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateColumnInput = {
  organizationId: string;
  boardId: string;
  name: string;
  color?: string | null;
  statusKey?: string | null;
  position?: number;
};

export type UpdateColumnInput = {
  name?: string;
  color?: string | null;
  statusKey?: string | null;
  position?: number;
};

export interface ColumnStore {
  listColumnsByBoard(
    organizationId: string,
    boardId: string,
  ): Promise<ColumnRecord[]>;
  getColumnById(
    organizationId: string,
    columnId: string,
  ): Promise<ColumnRecord | null>;
  createColumn(input: CreateColumnInput): Promise<ColumnRecord | null>;
  updateColumn(
    organizationId: string,
    columnId: string,
    input: UpdateColumnInput,
  ): Promise<ColumnRecord | null>;
}

export type CardRecord = {
  id: string;
  organizationId: string;
  boardId: string;
  columnId: string | null;
  title: string;
  description: string | null;
  statusKey: string;
  priority: string;
  department: string | null;
  dueAt: Date | null;
  startAt: Date | null;
  completedAt: Date | null;
  blockedReason: string | null;
  aiGenerated: boolean;
  position: number;
  metadata: unknown;
  trackedSecondsCache: number;
  isBillable: boolean;
  estimatedSeconds: number;
  archivedAt: Date | null;
  assignedTo: string | null;
  createdBy: string | null;
  legacyOfficeId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateCardInput = {
  organizationId: string;
  boardId: string;
  columnId: string;
  createdBy: string;
  title: string;
  description?: string | null;
  statusKey?: string;
  priority?: string;
  department?: string | null;
  dueAt?: Date | null;
  startAt?: Date | null;
  position?: number;
  isBillable?: boolean;
  estimatedSeconds?: number;
  metadata?: Record<string, unknown>;
};

export type UpdateCardInput = {
  title?: string;
  description?: string | null;
  columnId?: string;
  statusKey?: string;
  priority?: string;
  department?: string | null;
  dueAt?: Date | null;
  startAt?: Date | null;
  completedAt?: Date | null;
  blockedReason?: string | null;
  position?: number;
  isBillable?: boolean;
  estimatedSeconds?: number;
  metadata?: Record<string, unknown>;
};

export interface CardStore {
  listCardsByBoard(
    organizationId: string,
    boardId: string,
  ): Promise<CardRecord[]>;
  getCardById(
    organizationId: string,
    cardId: string,
  ): Promise<CardRecord | null>;
  createCard(input: CreateCardInput): Promise<CardRecord | null>;
  updateCard(
    organizationId: string,
    cardId: string,
    input: UpdateCardInput,
    actorUserId?: string,
  ): Promise<CardRecord | null>;
}

export type OrganizationMemberRecord = {
  userId: string;
  organizationId: string;
  status: string;
  accountStatus: string;
  isActive: boolean;
};

export type CommentRecord = {
  id: string;
  cardId: string;
  organizationId: string;
  userId: string | null;
  body: string;
  isInternal: boolean;
  commentType: string;
  createdAt: Date;
  updatedAt: Date;
};

export type LabelRecord = {
  id: string;
  organizationId: string;
  name: string;
  color: string;
  createdAt: Date;
};

export type CardLabelRecord = {
  id: string;
  cardId: string;
  labelId: string;
  organizationId: string;
  name: string;
  color: string;
  createdAt: Date;
};

export type WatcherRecord = {
  id: string;
  cardId: string;
  organizationId: string;
  userId: string;
  createdAt: Date;
};

export type AssigneeRecord = {
  id: string;
  cardId: string;
  organizationId: string;
  userId: string;
  createdAt: Date;
};

export type CardUpdateRecord = {
  id: string;
  cardId: string;
  organizationId: string;
  boardId: string | null;
  userId: string | null;
  updateType: string;
  message: string;
  metadata: unknown;
  createdAt: Date;
};

export type SubmissionRecord = {
  id: string;
  cardId: string;
  organizationId: string;
  submittedBy: string;
  reviewedBy: string | null;
  submissionType: string;
  title: string;
  notes: string | null;
  linkUrl: string | null;
  filePath: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  approvalStatus: string;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AttachmentRecord = {
  id: string;
  cardId: string;
  organizationId: string;
  uploadedBy: string;
  bucket: string;
  objectKey: string;
  originalFilename: string;
  contentType: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  createdAt: Date;
};

export type TimeEntryRecord = {
  id: string;
  cardId: string;
  organizationId: string;
  userId: string;
  createdBy: string;
  seconds: number;
  note: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  isBillable: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateCommentInput = {
  organizationId: string;
  cardId: string;
  userId: string;
  body: string;
  isInternal?: boolean;
  commentType?: string;
};

export type UpdateCommentInput = {
  body?: string;
  isInternal?: boolean;
};

export type CreateLabelInput = {
  organizationId: string;
  name: string;
  color: string;
};

export type UpdateLabelInput = {
  name?: string;
  color?: string;
};

export type CreateSubmissionInput = {
  organizationId: string;
  cardId: string;
  submittedBy: string;
  submissionType?: string;
  title: string;
  notes?: string | null;
  linkUrl?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
};

export type UpdateSubmissionInput = {
  title?: string;
  notes?: string | null;
  linkUrl?: string | null;
  approvalStatus?: string;
  reviewNote?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
};

export type CreateAttachmentInput = {
  id: string;
  organizationId: string;
  cardId: string;
  uploadedBy: string;
  bucket: string;
  objectKey: string;
  originalFilename: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  checksum?: string | null;
};

export type CreateTimeEntryInput = {
  organizationId: string;
  cardId: string;
  userId: string;
  createdBy: string;
  seconds: number;
  note?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  isBillable?: boolean;
};

export type UpdateTimeEntryInput = {
  seconds?: number;
  note?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  isBillable?: boolean;
};

export type RelationResult<T> = T | 'duplicate' | null;

export interface CardEcosystemStore {
  getOrganizationMember(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMemberRecord | null>;

  listCommentsByCard(
    organizationId: string,
    cardId: string,
  ): Promise<CommentRecord[]>;
  getCommentById(
    organizationId: string,
    commentId: string,
  ): Promise<CommentRecord | null>;
  createComment(input: CreateCommentInput): Promise<CommentRecord | null>;
  updateComment(
    organizationId: string,
    commentId: string,
    input: UpdateCommentInput,
  ): Promise<CommentRecord | null>;

  listLabels(organizationId: string): Promise<LabelRecord[]>;
  getLabelById(
    organizationId: string,
    labelId: string,
  ): Promise<LabelRecord | null>;
  createLabel(input: CreateLabelInput): Promise<LabelRecord>;
  updateLabel(
    organizationId: string,
    labelId: string,
    input: UpdateLabelInput,
  ): Promise<LabelRecord | null>;
  listCardLabels(
    organizationId: string,
    cardId: string,
  ): Promise<CardLabelRecord[]>;
  assignCardLabel(
    organizationId: string,
    cardId: string,
    labelId: string,
    actorUserId: string,
  ): Promise<RelationResult<CardLabelRecord>>;
  removeCardLabel(
    organizationId: string,
    cardId: string,
    labelId: string,
    actorUserId: string,
  ): Promise<boolean>;

  listWatchers(
    organizationId: string,
    cardId: string,
  ): Promise<WatcherRecord[]>;
  addWatcher(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ): Promise<RelationResult<WatcherRecord>>;
  removeWatcher(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ): Promise<boolean>;

  listAssignees(
    organizationId: string,
    cardId: string,
  ): Promise<AssigneeRecord[]>;
  addAssignee(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ): Promise<RelationResult<AssigneeRecord>>;
  removeAssignee(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ): Promise<boolean>;

  listCardUpdates(
    organizationId: string,
    cardId: string,
  ): Promise<CardUpdateRecord[]>;

  listSubmissionsByCard(
    organizationId: string,
    cardId: string,
  ): Promise<SubmissionRecord[]>;
  getSubmissionById(
    organizationId: string,
    submissionId: string,
  ): Promise<SubmissionRecord | null>;
  createSubmission(
    input: CreateSubmissionInput,
  ): Promise<SubmissionRecord | null>;
  updateSubmission(
    organizationId: string,
    submissionId: string,
    input: UpdateSubmissionInput,
  ): Promise<SubmissionRecord | null>;

  listAttachmentsByCard(
    organizationId: string,
    cardId: string,
  ): Promise<AttachmentRecord[]>;
  getAttachmentById(
    organizationId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null>;
  createAttachment(
    input: CreateAttachmentInput,
  ): Promise<AttachmentRecord | null>;
  deleteAttachment(
    organizationId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null>;

  listTimeEntriesByCard(
    organizationId: string,
    cardId: string,
  ): Promise<TimeEntryRecord[]>;
  getTimeEntryById(
    organizationId: string,
    timeEntryId: string,
  ): Promise<TimeEntryRecord | null>;
  createTimeEntry(
    input: CreateTimeEntryInput,
  ): Promise<TimeEntryRecord | null>;
  updateTimeEntry(
    organizationId: string,
    timeEntryId: string,
    input: UpdateTimeEntryInput,
  ): Promise<TimeEntryRecord | null>;
}

export type WorkStore = BoardStore & ColumnStore & CardStore & CardEcosystemStore;
