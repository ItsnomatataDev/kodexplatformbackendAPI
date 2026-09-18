import { randomUUID } from 'node:crypto';
import type {
  AssigneeRecord,
  AttachmentRecord,
  BoardRecord,
  CardLabelRecord,
  CardRecord,
  CardUpdateRecord,
  ChecklistItemRecord,
  ChecklistRecord,
  CommentRecord,
  CreateAttachmentInput,
  CreateBoardInput,
  CreateCardInput,
  CreateChecklistInput,
  CreateChecklistItemInput,
  CreateColumnInput,
  CreateCommentInput,
  CreateLabelInput,
  CreateSubmissionInput,
  CreateTimeEntryInput,
  ColumnRecord,
  LabelRecord,
  OrganizationMemberRecord,
  SubmissionRecord,
  TimeEntryRecord,
  UpdateBoardInput,
  UpdateCardInput,
  UpdateChecklistInput,
  UpdateChecklistItemInput,
  UpdateColumnInput,
  UpdateCommentInput,
  UpdateLabelInput,
  UpdateSubmissionInput,
  UpdateTimeEntryInput,
  WatcherRecord,
  WorkStore,
} from './store.js';

export class MemoryBoardStore implements WorkStore {
  private readonly boards = new Map<string, BoardRecord>();
  private readonly columns = new Map<string, ColumnRecord>();
  private readonly cards = new Map<string, CardRecord>();
  private readonly members = new Map<string, OrganizationMemberRecord>();
  private readonly comments = new Map<string, CommentRecord>();
  private readonly labels = new Map<string, LabelRecord>();
  private readonly cardLabels = new Map<string, CardLabelRecord>();
  private readonly watchers = new Map<string, WatcherRecord>();
  private readonly assignees = new Map<string, AssigneeRecord>();
  private readonly updates = new Map<string, CardUpdateRecord>();
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly attachments = new Map<string, AttachmentRecord>();
  private readonly timeEntries = new Map<string, TimeEntryRecord>();
  private readonly checklists = new Map<string, ChecklistRecord>();
  private readonly checklistItems = new Map<string, ChecklistItemRecord>();

  seedOrganizationMember(member: OrganizationMemberRecord) {
    this.members.set(`${member.organizationId}:${member.userId}`, { ...member });
  }

  async listByOrganization(organizationId: string) {
    return [...this.boards.values()]
      .filter(
        (board) =>
          board.organizationId === organizationId && board.archivedAt == null,
      )
      .sort((left, right) => {
        if (left.position !== right.position) {
          return left.position - right.position;
        }

        return right.createdAt.getTime() - left.createdAt.getTime();
      })
      .map((board) => ({ ...board }));
  }

  async getById(organizationId: string, boardId: string) {
    const board = this.boards.get(boardId);

    if (!board || board.organizationId !== organizationId) {
      return null;
    }

    return { ...board };
  }

  async create(input: CreateBoardInput) {
    const now = new Date();
    const board: BoardRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      ownerId: input.ownerId ?? null,
      name: input.name,
      slug: input.slug ?? null,
      description: input.description ?? null,
      status: input.status ?? 'active',
      color: input.color ?? null,
      position: input.position ?? 0,
      metadata: input.metadata ?? {},
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.boards.set(board.id, board);
    return { ...board };
  }

  async update(
    organizationId: string,
    boardId: string,
    input: UpdateBoardInput,
  ) {
    const board = this.boards.get(boardId);

    if (!board || board.organizationId !== organizationId) {
      return null;
    }

    if (input.name !== undefined) board.name = input.name;
    if (input.slug !== undefined) board.slug = input.slug;
    if (input.description !== undefined) board.description = input.description;
    if (input.status !== undefined) board.status = input.status;
    if (input.color !== undefined) board.color = input.color;
    if (input.position !== undefined) board.position = input.position;
    if (input.metadata !== undefined) board.metadata = input.metadata;
    if (input.ownerId !== undefined) board.ownerId = input.ownerId;
    board.updatedAt = new Date();

    return { ...board };
  }

  async listColumnsByBoard(organizationId: string, boardId: string) {
    return [...this.columns.values()]
      .filter(
        (column) =>
          column.organizationId === organizationId &&
          column.boardId === boardId,
      )
      .sort((left, right) => {
        if (left.position !== right.position) {
          return left.position - right.position;
        }

        return left.createdAt.getTime() - right.createdAt.getTime();
      })
      .map((column) => ({ ...column }));
  }

  async getColumnById(organizationId: string, columnId: string) {
    const column = this.columns.get(columnId);

    if (!column || column.organizationId !== organizationId) {
      return null;
    }

    const board = this.boards.get(column.boardId);
    if (!board || board.organizationId !== organizationId) {
      return null;
    }

    return { ...column };
  }

  async createColumn(input: CreateColumnInput) {
    const board = this.boards.get(input.boardId);

    if (!board || board.organizationId !== input.organizationId) {
      return null;
    }

    const now = new Date();
    const column: ColumnRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      boardId: input.boardId,
      name: input.name,
      color: input.color ?? null,
      statusKey: input.statusKey ?? null,
      position: input.position ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    this.columns.set(column.id, column);
    return { ...column };
  }

  async updateColumn(
    organizationId: string,
    columnId: string,
    input: UpdateColumnInput,
  ) {
    const current = await this.getColumnById(organizationId, columnId);

    if (!current) {
      return null;
    }

    const column = this.columns.get(columnId)!;
    if (input.name !== undefined) column.name = input.name;
    if (input.color !== undefined) column.color = input.color;
    if (input.statusKey !== undefined) column.statusKey = input.statusKey;
    if (input.position !== undefined) column.position = input.position;
    column.updatedAt = new Date(
      Math.max(Date.now(), column.updatedAt.getTime() + 1),
    );

    return { ...column };
  }

  async listCardsByBoard(organizationId: string, boardId: string) {
    return [...this.cards.values()]
      .filter(
        (card) =>
          card.organizationId === organizationId && card.boardId === boardId,
      )
      .sort((left, right) => {
        if (left.position !== right.position) {
          return left.position - right.position;
        }

        const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
        if (createdDelta !== 0) {
          return createdDelta;
        }

        return left.id.localeCompare(right.id);
      })
      .map((card) => this.cloneCard(card));
  }

  async getCardById(organizationId: string, cardId: string) {
    const card = this.cards.get(cardId);

    if (!card || card.organizationId !== organizationId) {
      return null;
    }

    const board = this.boards.get(card.boardId);
    if (!board || board.organizationId !== organizationId) {
      return null;
    }

    return this.cloneCard(card);
  }

  async createCard(input: CreateCardInput) {
    const board = this.boards.get(input.boardId);

    if (!board || board.organizationId !== input.organizationId) {
      return null;
    }

    const column = this.columns.get(input.columnId);

    if (
      !column ||
      column.organizationId !== input.organizationId ||
      column.boardId !== input.boardId
    ) {
      return null;
    }

    const now = new Date();
    const card: CardRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      boardId: input.boardId,
      columnId: input.columnId,
      title: input.title,
      description: input.description ?? null,
      statusKey: input.statusKey ?? column.statusKey ?? 'todo',
      priority: input.priority ?? 'normal',
      department: input.department ?? null,
      dueAt: input.dueAt ?? null,
      startAt: input.startAt ?? null,
      completedAt: null,
      blockedReason: null,
      aiGenerated: false,
      position:
        input.position ??
        this.nextCardPosition(
          input.organizationId,
          input.boardId,
          input.columnId,
        ),
      metadata: input.metadata ? { ...input.metadata } : {},
      trackedSecondsCache: 0,
      isBillable: input.isBillable ?? false,
    estimatedSeconds: input.estimatedSeconds ?? 0,
    archivedAt: null,
    assignedTo: null,
    createdBy: input.createdBy,
    legacyOfficeId: null,
    createdAt: now,
    updatedAt: now,
  };

    this.cards.set(card.id, card);
    this.recordUpdate(card, input.createdBy, 'created', `Created card "${card.title}"`, {
      title: card.title,
    });
    return this.cloneCard(card);
  }

  async updateCard(
    organizationId: string,
    cardId: string,
    input: UpdateCardInput,
    actorUserId?: string,
  ) {
    const current = await this.getCardById(organizationId, cardId);

    if (!current) {
      return null;
    }

    if (input.columnId !== undefined) {
      const column = this.columns.get(input.columnId);

      if (
        !column ||
        column.organizationId !== organizationId ||
        column.boardId !== current.boardId
      ) {
        return null;
      }
    }

    const card = this.cards.get(cardId)!;
    if (input.title !== undefined) card.title = input.title;
    if (input.description !== undefined) card.description = input.description;
    if (input.columnId !== undefined) card.columnId = input.columnId;
    if (input.statusKey !== undefined) card.statusKey = input.statusKey;
    if (input.priority !== undefined) card.priority = input.priority;
    if (input.department !== undefined) card.department = input.department;
    if (input.dueAt !== undefined) card.dueAt = input.dueAt;
    if (input.startAt !== undefined) card.startAt = input.startAt;
    if (input.completedAt !== undefined) card.completedAt = input.completedAt;
    if (input.blockedReason !== undefined) card.blockedReason = input.blockedReason;
    if (input.position !== undefined) card.position = input.position;
    if (input.isBillable !== undefined) card.isBillable = input.isBillable;
    if (input.estimatedSeconds !== undefined) {
      card.estimatedSeconds = input.estimatedSeconds;
    }
    if (input.metadata !== undefined) card.metadata = { ...input.metadata };
    card.updatedAt = new Date(
      Math.max(Date.now(), card.updatedAt.getTime() + 1),
    );

    if (actorUserId) {
      this.recordCardFieldUpdates(current, card, actorUserId);
    }

    return this.cloneCard(card);
  }

  async getOrganizationMember(organizationId: string, userId: string) {
    const member = this.members.get(`${organizationId}:${userId}`);
    if (
      !member ||
      member.status !== 'active' ||
      !member.isActive ||
      member.accountStatus !== 'active'
    ) {
      return null;
    }

    return { ...member };
  }

  async listCommentsByCard(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.comments.values()]
      .filter(
        (comment) =>
          comment.organizationId === organizationId && comment.cardId === cardId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((comment) => ({ ...comment }));
  }

  async getCommentById(organizationId: string, commentId: string) {
    const comment = this.comments.get(commentId);
    if (!comment || comment.organizationId !== organizationId) {
      return null;
    }

    const card = await this.getCardById(organizationId, comment.cardId);
    if (!card) {
      return null;
    }

    return { ...comment };
  }

  async createComment(input: CreateCommentInput) {
    const card = await this.getCardById(input.organizationId, input.cardId);
    if (!card) {
      return null;
    }

    const now = new Date();
    const comment: CommentRecord = {
      id: randomUUID(),
      cardId: input.cardId,
      organizationId: input.organizationId,
      userId: input.userId,
      body: input.body,
      isInternal: input.isInternal ?? false,
      commentType: input.commentType ?? 'comment',
      createdAt: now,
      updatedAt: now,
    };
    this.comments.set(comment.id, comment);
    this.recordUpdate(card, input.userId, 'commented', 'Added a comment');
    return { ...comment };
  }

  async updateComment(
    organizationId: string,
    commentId: string,
    input: UpdateCommentInput,
  ) {
    const current = await this.getCommentById(organizationId, commentId);
    if (!current) {
      return null;
    }

    const comment = this.comments.get(commentId)!;
    if (input.body !== undefined) comment.body = input.body;
    if (input.isInternal !== undefined) comment.isInternal = input.isInternal;
    comment.updatedAt = new Date(
      Math.max(Date.now(), comment.updatedAt.getTime() + 1),
    );
    return { ...comment };
  }

  async listLabels(organizationId: string) {
    return [...this.labels.values()]
      .filter((label) => label.organizationId === organizationId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((label) => ({ ...label }));
  }

  async getLabelById(organizationId: string, labelId: string) {
    const label = this.labels.get(labelId);
    if (!label || label.organizationId !== organizationId) {
      return null;
    }

    return { ...label };
  }

  async createLabel(input: CreateLabelInput) {
    const label: LabelRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      color: input.color,
      createdAt: new Date(),
    };
    this.labels.set(label.id, label);
    return { ...label };
  }

  async updateLabel(
    organizationId: string,
    labelId: string,
    input: UpdateLabelInput,
  ) {
    const current = await this.getLabelById(organizationId, labelId);
    if (!current) {
      return null;
    }

    const label = this.labels.get(labelId)!;
    if (input.name !== undefined) label.name = input.name;
    if (input.color !== undefined) label.color = input.color;
    return { ...label };
  }

  async listCardLabels(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.cardLabels.values()]
      .filter(
        (assignment) =>
          assignment.organizationId === organizationId &&
          assignment.cardId === cardId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((assignment) => ({ ...assignment }));
  }

  async assignCardLabel(
    organizationId: string,
    cardId: string,
    labelId: string,
    actorUserId: string,
  ) {
    const card = await this.getCardById(organizationId, cardId);
    const label = await this.getLabelById(organizationId, labelId);
    if (!card || !label) {
      return null;
    }

    const duplicate = [...this.cardLabels.values()].find(
      (assignment) => assignment.cardId === cardId && assignment.labelId === labelId,
    );
    if (duplicate) {
      return 'duplicate';
    }

    const assignment: CardLabelRecord = {
      id: randomUUID(),
      cardId,
      labelId,
      organizationId,
      name: label.name,
      color: label.color,
      createdAt: new Date(),
    };
    this.cardLabels.set(assignment.id, assignment);
    this.recordUpdate(card, actorUserId, 'label_added', `Added label "${label.name}"`, {
      labelId,
    });
    return { ...assignment };
  }

  async removeCardLabel(
    organizationId: string,
    cardId: string,
    labelId: string,
    actorUserId: string,
  ) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return false;
    }

    const assignment = [...this.cardLabels.values()].find(
      (item) =>
        item.organizationId === organizationId &&
        item.cardId === cardId &&
        item.labelId === labelId,
    );
    if (!assignment) {
      return false;
    }

    this.cardLabels.delete(assignment.id);
    this.recordUpdate(card, actorUserId, 'label_removed', `Removed label "${assignment.name}"`, {
      labelId,
    });
    return true;
  }

  async listWatchers(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.watchers.values()]
      .filter(
        (watcher) =>
          watcher.organizationId === organizationId && watcher.cardId === cardId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((watcher) => ({ ...watcher }));
  }

  async addWatcher(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ) {
    const card = await this.getCardById(organizationId, cardId);
    const member = await this.getOrganizationMember(organizationId, userId);
    if (!card || !member) {
      return null;
    }

    const duplicate = [...this.watchers.values()].find(
      (watcher) => watcher.cardId === cardId && watcher.userId === userId,
    );
    if (duplicate) {
      return 'duplicate';
    }

    const watcher: WatcherRecord = {
      id: randomUUID(),
      cardId,
      organizationId,
      userId,
      createdAt: new Date(),
    };
    this.watchers.set(watcher.id, watcher);
    this.recordUpdate(card, actorUserId, 'watcher_added', 'Added a watcher', { userId });
    return { ...watcher };
  }

  async removeWatcher(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return false;
    }

    const watcher = [...this.watchers.values()].find(
      (item) =>
        item.organizationId === organizationId &&
        item.cardId === cardId &&
        item.userId === userId,
    );
    if (!watcher) {
      return false;
    }

    this.watchers.delete(watcher.id);
    this.recordUpdate(card, actorUserId, 'watcher_removed', 'Removed a watcher', {
      userId,
    });
    return true;
  }

  async listAssignees(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.assignees.values()]
      .filter(
        (assignee) =>
          assignee.organizationId === organizationId && assignee.cardId === cardId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((assignee) => ({ ...assignee }));
  }

  async addAssignee(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ) {
    const card = await this.getCardById(organizationId, cardId);
    const member = await this.getOrganizationMember(organizationId, userId);
    if (!card || !member) {
      return null;
    }

    const duplicate = [...this.assignees.values()].find(
      (assignee) => assignee.cardId === cardId && assignee.userId === userId,
    );
    if (duplicate) {
      return 'duplicate';
    }

    const assignee: AssigneeRecord = {
      id: randomUUID(),
      cardId,
      organizationId,
      userId,
      createdAt: new Date(),
    };
    this.assignees.set(assignee.id, assignee);
    this.recordUpdate(card, actorUserId, 'assigned', 'Assigned a member', { userId });
    return { ...assignee };
  }

  async removeAssignee(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return false;
    }

    const assignee = [...this.assignees.values()].find(
      (item) =>
        item.organizationId === organizationId &&
        item.cardId === cardId &&
        item.userId === userId,
    );
    if (!assignee) {
      return false;
    }

    this.assignees.delete(assignee.id);
    this.recordUpdate(card, actorUserId, 'unassigned', 'Removed an assignee', {
      userId,
    });
    return true;
  }

  async listCardUpdates(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.updates.values()]
      .filter(
        (update) =>
          update.organizationId === organizationId && update.cardId === cardId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((update) => ({
        ...update,
        metadata:
          update.metadata && typeof update.metadata === 'object'
            ? { ...(update.metadata as Record<string, unknown>) }
            : update.metadata,
      }));
  }

  async listSubmissionsByCard(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.submissions.values()]
      .filter(
        (submission) =>
          submission.organizationId === organizationId &&
          submission.cardId === cardId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((submission) => ({ ...submission }));
  }

  async getSubmissionById(organizationId: string, submissionId: string) {
    const submission = this.submissions.get(submissionId);
    if (!submission || submission.organizationId !== organizationId) {
      return null;
    }

    const card = await this.getCardById(organizationId, submission.cardId);
    if (!card) {
      return null;
    }

    return { ...submission };
  }

  async createSubmission(input: CreateSubmissionInput) {
    const card = await this.getCardById(input.organizationId, input.cardId);
    if (!card) {
      return null;
    }

    const now = new Date();
    const submission: SubmissionRecord = {
      id: randomUUID(),
      cardId: input.cardId,
      organizationId: input.organizationId,
      submittedBy: input.submittedBy,
      reviewedBy: null,
      submissionType: input.submissionType ?? (input.linkUrl ? 'link' : 'note'),
      title: input.title,
      notes: input.notes ?? null,
      linkUrl: input.linkUrl ?? null,
      filePath: null,
      fileName: input.fileName ?? null,
      mimeType: input.mimeType ?? null,
      fileSize: input.fileSize ?? null,
      approvalStatus: 'pending',
      reviewedAt: null,
      reviewNote: null,
      createdAt: now,
      updatedAt: now,
    };
    this.submissions.set(submission.id, submission);
    this.recordUpdate(card, input.submittedBy, 'submission_created', `Submitted "${submission.title}"`);
    return { ...submission };
  }

  async updateSubmission(
    organizationId: string,
    submissionId: string,
    input: UpdateSubmissionInput,
  ) {
    const current = await this.getSubmissionById(organizationId, submissionId);
    if (!current) {
      return null;
    }

    const submission = this.submissions.get(submissionId)!;
    if (input.title !== undefined) submission.title = input.title;
    if (input.notes !== undefined) submission.notes = input.notes;
    if (input.linkUrl !== undefined) submission.linkUrl = input.linkUrl;
    if (input.approvalStatus !== undefined) {
      submission.approvalStatus = input.approvalStatus;
    }
    if (input.reviewNote !== undefined) submission.reviewNote = input.reviewNote;
    if (input.reviewedBy !== undefined) submission.reviewedBy = input.reviewedBy;
    if (input.reviewedAt !== undefined) submission.reviewedAt = input.reviewedAt;
    submission.updatedAt = new Date(
      Math.max(Date.now(), submission.updatedAt.getTime() + 1),
    );
    return { ...submission };
  }

  async listAttachmentsByCard(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.attachments.values()]
      .filter(
        (attachment) =>
          attachment.organizationId === organizationId &&
          attachment.cardId === cardId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((attachment) => ({ ...attachment }));
  }

  async getAttachmentById(organizationId: string, attachmentId: string) {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment || attachment.organizationId !== organizationId) {
      return null;
    }

    const card = await this.getCardById(organizationId, attachment.cardId);
    if (!card) {
      return null;
    }

    return { ...attachment };
  }

  async createAttachment(input: CreateAttachmentInput) {
    const card = await this.getCardById(input.organizationId, input.cardId);
    if (!card) {
      return null;
    }

    const attachment: AttachmentRecord = {
      id: input.id,
      cardId: input.cardId,
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
    this.recordUpdate(
      card,
      input.uploadedBy,
      'attachment_added',
      `Attached "${attachment.originalFilename}"`,
    );
    return { ...attachment };
  }

  async deleteAttachment(organizationId: string, attachmentId: string) {
    const current = await this.getAttachmentById(organizationId, attachmentId);
    if (!current) {
      return null;
    }

    this.attachments.delete(attachmentId);
    return { ...current };
  }

  async listTimeEntriesByCard(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.timeEntries.values()]
      .filter(
        (entry) =>
          entry.organizationId === organizationId && entry.cardId === cardId,
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((entry) => ({ ...entry }));
  }

  async getTimeEntryById(organizationId: string, timeEntryId: string) {
    const entry = this.timeEntries.get(timeEntryId);
    if (!entry || entry.organizationId !== organizationId) {
      return null;
    }

    const card = await this.getCardById(organizationId, entry.cardId);
    if (!card) {
      return null;
    }

    return { ...entry };
  }

  async createTimeEntry(input: CreateTimeEntryInput) {
    const card = await this.getCardById(input.organizationId, input.cardId);
    const member = await this.getOrganizationMember(
      input.organizationId,
      input.userId,
    );
    if (!card || !member) {
      return null;
    }

    const now = new Date();
    const entry: TimeEntryRecord = {
      id: randomUUID(),
      cardId: input.cardId,
      organizationId: input.organizationId,
      userId: input.userId,
      createdBy: input.createdBy,
      seconds: input.seconds,
      note: input.note ?? null,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      isBillable: input.isBillable ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.timeEntries.set(entry.id, entry);
    await this.refreshTrackedSeconds(input.organizationId, input.cardId);
    this.recordUpdate(card, input.createdBy, 'time_logged', 'Logged time', {
      seconds: input.seconds,
    });
    return { ...entry };
  }

  async updateTimeEntry(
    organizationId: string,
    timeEntryId: string,
    input: UpdateTimeEntryInput,
  ) {
    const current = await this.getTimeEntryById(organizationId, timeEntryId);
    if (!current) {
      return null;
    }

    const entry = this.timeEntries.get(timeEntryId)!;
    if (input.seconds !== undefined) entry.seconds = input.seconds;
    if (input.note !== undefined) entry.note = input.note;
    if (input.startedAt !== undefined) entry.startedAt = input.startedAt;
    if (input.endedAt !== undefined) entry.endedAt = input.endedAt;
    if (input.isBillable !== undefined) entry.isBillable = input.isBillable;
    entry.updatedAt = new Date(
      Math.max(Date.now(), entry.updatedAt.getTime() + 1),
    );
    await this.refreshTrackedSeconds(organizationId, entry.cardId);
    return { ...entry };
  }

  async listChecklistsByCard(organizationId: string, cardId: string) {
    const card = await this.getCardById(organizationId, cardId);
    if (!card) {
      return [];
    }

    return [...this.checklists.values()]
      .filter(
        (checklist) =>
          checklist.organizationId === organizationId &&
          checklist.cardId === cardId,
      )
      .sort((left, right) => {
        if (left.position !== right.position) {
          return left.position - right.position;
        }
        return left.createdAt.getTime() - right.createdAt.getTime();
      })
      .map((checklist) => this.cloneChecklist(checklist));
  }

  async getChecklistById(organizationId: string, checklistId: string) {
    const checklist = this.checklists.get(checklistId);
    if (!checklist || checklist.organizationId !== organizationId) {
      return null;
    }

    const card = await this.getCardById(organizationId, checklist.cardId);
    if (!card) {
      return null;
    }

    return this.cloneChecklist(checklist);
  }

  async createChecklist(input: CreateChecklistInput) {
    const card = await this.getCardById(input.organizationId, input.cardId);
    if (!card) {
      return null;
    }

    const now = new Date();
    const checklist: ChecklistRecord = {
      id: randomUUID(),
      cardId: input.cardId,
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      title: input.title,
      position:
        input.position ??
        this.nextChecklistPosition(input.organizationId, input.cardId),
      createdAt: now,
      updatedAt: now,
      items: [],
    };
    this.checklists.set(checklist.id, checklist);
    this.recordUpdate(
      card,
      input.createdBy,
      'checklist_added',
      `Added checklist "${checklist.title}"`,
    );
    return this.cloneChecklist(checklist);
  }

  async updateChecklist(
    organizationId: string,
    checklistId: string,
    input: UpdateChecklistInput,
  ) {
    const current = await this.getChecklistById(organizationId, checklistId);
    if (!current) {
      return null;
    }

    const checklist = this.checklists.get(checklistId)!;
    if (input.title !== undefined) checklist.title = input.title;
    if (input.position !== undefined) checklist.position = input.position;
    checklist.updatedAt = new Date(
      Math.max(Date.now(), checklist.updatedAt.getTime() + 1),
    );
    return this.cloneChecklist(checklist);
  }

  async deleteChecklist(organizationId: string, checklistId: string) {
    const current = await this.getChecklistById(organizationId, checklistId);
    if (!current) {
      return false;
    }

    for (const [itemId, item] of this.checklistItems) {
      if (item.checklistId === checklistId && item.organizationId === organizationId) {
        this.checklistItems.delete(itemId);
      }
    }
    this.checklists.delete(checklistId);
    return true;
  }

  async getChecklistItemById(organizationId: string, itemId: string) {
    const item = this.checklistItems.get(itemId);
    if (!item || item.organizationId !== organizationId) {
      return null;
    }

    const checklist = await this.getChecklistById(organizationId, item.checklistId);
    if (!checklist) {
      return null;
    }

    return { ...item };
  }

  async createChecklistItem(input: CreateChecklistItemInput) {
    const checklist = await this.getChecklistById(
      input.organizationId,
      input.checklistId,
    );
    if (!checklist) {
      return null;
    }

    const card = await this.getCardById(input.organizationId, checklist.cardId);
    if (!card) {
      return null;
    }

    const now = new Date();
    const item: ChecklistItemRecord = {
      id: randomUUID(),
      checklistId: checklist.id,
      cardId: checklist.cardId,
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      completedBy: null,
      content: input.content,
      isCompleted: false,
      completedAt: null,
      position:
        input.position ??
        this.nextChecklistItemPosition(input.organizationId, checklist.id),
      createdAt: now,
      updatedAt: now,
    };
    this.checklistItems.set(item.id, item);
    this.recordUpdate(
      card,
      input.createdBy,
      'checklist_item_added',
      `Added checklist item "${item.content}"`,
    );
    return { ...item };
  }

  async updateChecklistItem(
    organizationId: string,
    itemId: string,
    input: UpdateChecklistItemInput,
    actorUserId: string,
  ) {
    const current = await this.getChecklistItemById(organizationId, itemId);
    if (!current) {
      return null;
    }

    const item = this.checklistItems.get(itemId)!;
    if (input.content !== undefined) item.content = input.content;
    if (input.position !== undefined) item.position = input.position;
    if (input.isCompleted !== undefined) {
      item.isCompleted = input.isCompleted;
      item.completedAt = input.isCompleted ? new Date() : null;
      item.completedBy = input.isCompleted ? actorUserId : null;
    }
    item.updatedAt = new Date(Math.max(Date.now(), item.updatedAt.getTime() + 1));
    return { ...item };
  }

  async deleteChecklistItem(organizationId: string, itemId: string) {
    const current = await this.getChecklistItemById(organizationId, itemId);
    if (!current) {
      return false;
    }

    this.checklistItems.delete(itemId);
    return true;
  }

  private nextCardPosition(
    organizationId: string,
    boardId: string,
    columnId: string,
  ) {
    const positions = [...this.cards.values()]
      .filter(
        (card) =>
          card.organizationId === organizationId &&
          card.boardId === boardId &&
          card.columnId === columnId,
      )
      .map((card) => card.position);

    if (positions.length === 0) {
      return 0;
    }

    return Math.max(...positions) + 1;
  }

  private async refreshTrackedSeconds(organizationId: string, cardId: string) {
    const card = this.cards.get(cardId);
    if (!card || card.organizationId !== organizationId) {
      return;
    }

    card.trackedSecondsCache = [...this.timeEntries.values()]
      .filter(
        (entry) =>
          entry.organizationId === organizationId && entry.cardId === cardId,
      )
      .reduce((total, entry) => total + entry.seconds, 0);
  }

  private recordCardFieldUpdates(
    before: CardRecord,
    after: CardRecord,
    actorUserId: string,
  ) {
    if (before.title !== after.title) {
      this.recordUpdate(after, actorUserId, 'title_changed', `Renamed card to "${after.title}"`, {
        from: before.title,
        to: after.title,
      });
    }
    if (before.description !== after.description) {
      this.recordUpdate(after, actorUserId, 'description_changed', 'Updated description');
    }
    if (before.columnId !== after.columnId) {
      this.recordUpdate(after, actorUserId, 'column_moved', 'Moved card to another column', {
        from: before.columnId,
        to: after.columnId,
      });
    }
    if (before.statusKey !== after.statusKey) {
      this.recordUpdate(after, actorUserId, 'status_changed', `Changed status to ${after.statusKey}`, {
        from: before.statusKey,
        to: after.statusKey,
      });
    }
    if (before.priority !== after.priority) {
      this.recordUpdate(after, actorUserId, 'priority_changed', `Changed priority to ${after.priority}`, {
        from: before.priority,
        to: after.priority,
      });
    }
    if (before.completedAt?.getTime() !== after.completedAt?.getTime()) {
      this.recordUpdate(
        after,
        actorUserId,
        after.completedAt ? 'completed' : 'reopened',
        after.completedAt ? 'Marked card completed' : 'Cleared completion',
      );
    }
  }

  private recordUpdate(
    card: CardRecord,
    userId: string | null,
    updateType: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ) {
    const update: CardUpdateRecord = {
      id: randomUUID(),
      cardId: card.id,
      organizationId: card.organizationId,
      boardId: card.boardId,
      userId,
      updateType,
      message,
      metadata,
      createdAt: new Date(),
    };
    this.updates.set(update.id, update);
  }

  private cloneCard(card: CardRecord): CardRecord {
    return {
      ...card,
      metadata:
        card.metadata && typeof card.metadata === 'object'
          ? { ...(card.metadata as Record<string, unknown>) }
          : card.metadata,
    };
  }

  private nextChecklistPosition(organizationId: string, cardId: string) {
    const positions = [...this.checklists.values()]
      .filter(
        (checklist) =>
          checklist.organizationId === organizationId &&
          checklist.cardId === cardId,
      )
      .map((checklist) => checklist.position);
    return positions.length === 0 ? 0 : Math.max(...positions) + 1;
  }

  private nextChecklistItemPosition(organizationId: string, checklistId: string) {
    const positions = [...this.checklistItems.values()]
      .filter(
        (item) =>
          item.organizationId === organizationId &&
          item.checklistId === checklistId,
      )
      .map((item) => item.position);
    return positions.length === 0 ? 0 : Math.max(...positions) + 1;
  }

  private cloneChecklist(checklist: ChecklistRecord): ChecklistRecord {
    const items = [...this.checklistItems.values()]
      .filter(
        (item) =>
          item.organizationId === checklist.organizationId &&
          item.checklistId === checklist.id,
      )
      .sort((left, right) => {
        if (left.position !== right.position) {
          return left.position - right.position;
        }
        return left.createdAt.getTime() - right.createdAt.getTime();
      })
      .map((item) => ({ ...item }));

    return {
      ...checklist,
      items,
    };
  }
}
