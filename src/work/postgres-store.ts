import { db } from '../db/pool.js';
import type {
  AssigneeRecord,
  AttachmentRecord,
  BoardRecord,
  CardLabelRecord,
  CardRecord,
  CardUpdateRecord,
  CommentRecord,
  CreateAttachmentInput,
  CreateBoardInput,
  CreateCardInput,
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
  UpdateColumnInput,
  UpdateCommentInput,
  UpdateLabelInput,
  UpdateSubmissionInput,
  UpdateTimeEntryInput,
  WatcherRecord,
  WorkStore,
} from './store.js';

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === '23505',
  );
}

type BoardRow = {
  id: string;
  organization_id: string;
  created_by: string;
  owner_id: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  status: string;
  color: string | null;
  position: number;
  metadata: unknown;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const BOARD_COLUMNS = `
  id,
  organization_id,
  created_by,
  owner_id,
  name,
  slug,
  description,
  status,
  color,
  position,
  metadata,
  archived_at,
  created_at,
  updated_at
`;

function mapBoard(row: BoardRow): BoardRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    color: row.color,
    position: row.position,
    metadata: row.metadata,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type ColumnRow = {
  id: string;
  organization_id: string;
  board_id: string;
  name: string;
  color: string | null;
  status_key: string | null;
  position: number;
  created_at: Date;
  updated_at: Date;
};

const COLUMN_COLUMNS = `
  id,
  organization_id,
  board_id,
  name,
  color,
  status_key,
  position,
  created_at,
  updated_at
`;

function mapColumn(row: ColumnRow): ColumnRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    boardId: row.board_id,
    name: row.name,
    color: row.color,
    statusKey: row.status_key,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type CardRow = {
  id: string;
  organization_id: string;
  board_id: string;
  column_id: string | null;
  title: string;
  description: string | null;
  status_key: string;
  priority: string;
  department: string | null;
  due_at: Date | null;
  start_at: Date | null;
  completed_at: Date | null;
  blocked_reason: string | null;
  ai_generated: boolean;
  position: number;
  metadata: unknown;
  tracked_seconds_cache: number;
  is_billable: boolean;
  estimated_seconds: number;
  archived_at: Date | null;
  assigned_to: string | null;
  created_by: string | null;
  legacy_office_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const CARD_FIELDS = [
  'id',
  'organization_id',
  'board_id',
  'column_id',
  'title',
  'description',
  'status_key',
  'priority',
  'department',
  'due_at',
  'start_at',
  'completed_at',
  'blocked_reason',
  'ai_generated',
  'position',
  'metadata',
  'tracked_seconds_cache',
  'is_billable',
  'estimated_seconds',
  'archived_at',
  'assigned_to',
  'created_by',
  'legacy_office_id',
  'created_at',
  'updated_at',
] as const;

const CARD_RETURNING = CARD_FIELDS.join(', ');
const CARD_COLUMNS = CARD_FIELDS.map((field) => `card.${field}`).join(', ');

function mapCard(row: CardRow): CardRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    boardId: row.board_id,
    columnId: row.column_id,
    title: row.title,
    description: row.description,
    statusKey: row.status_key,
    priority: row.priority,
    department: row.department,
    dueAt: row.due_at,
    startAt: row.start_at,
    completedAt: row.completed_at,
    blockedReason: row.blocked_reason,
    aiGenerated: row.ai_generated,
    position: row.position,
    metadata: row.metadata,
    trackedSecondsCache: row.tracked_seconds_cache,
    isBillable: row.is_billable,
    estimatedSeconds: row.estimated_seconds,
    archivedAt: row.archived_at,
    assignedTo: row.assigned_to,
    createdBy: row.created_by,
    legacyOfficeId: row.legacy_office_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type CommentRow = {
  id: string;
  card_id: string;
  organization_id: string;
  user_id: string | null;
  body: string;
  is_internal: boolean;
  comment_type: string;
  created_at: Date;
  updated_at: Date;
};

const COMMENT_RETURNING = `
  id, card_id, organization_id, user_id, body, is_internal, comment_type, created_at, updated_at
`;
const COMMENT_COLUMNS = `
  comment.id, comment.card_id, comment.organization_id, comment.user_id, comment.body,
  comment.is_internal, comment.comment_type, comment.created_at, comment.updated_at
`;

function mapComment(row: CommentRow): CommentRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    body: row.body,
    isInternal: row.is_internal,
    commentType: row.comment_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type LabelRow = {
  id: string;
  organization_id: string;
  name: string;
  color: string;
  created_at: Date;
};

const LABEL_RETURNING = `id, organization_id, name, color, created_at`;

function mapLabel(row: LabelRow): LabelRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

type CardLabelRow = {
  id: string;
  card_id: string;
  label_id: string;
  organization_id: string;
  name: string;
  color: string;
  created_at: Date;
};

function mapCardLabel(row: CardLabelRow): CardLabelRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    labelId: row.label_id,
    organizationId: row.organization_id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

type WatcherRow = {
  id: string;
  card_id: string;
  organization_id: string;
  user_id: string;
  created_at: Date;
};

const WATCHER_RETURNING = `id, card_id, organization_id, user_id, created_at`;
const WATCHER_COLUMNS = `
  watcher.id, watcher.card_id, watcher.organization_id, watcher.user_id, watcher.created_at
`;

function mapWatcher(row: WatcherRow): WatcherRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

type AssigneeRow = {
  id: string;
  card_id: string;
  organization_id: string;
  user_id: string;
  created_at: Date;
};

const ASSIGNEE_RETURNING = `id, card_id, organization_id, user_id, created_at`;
const ASSIGNEE_COLUMNS = `
  assignee.id, assignee.card_id, assignee.organization_id, assignee.user_id, assignee.created_at
`;

function mapAssignee(row: AssigneeRow): AssigneeRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

type UpdateRow = {
  id: string;
  card_id: string;
  organization_id: string;
  board_id: string | null;
  user_id: string | null;
  update_type: string;
  message: string;
  metadata: unknown;
  created_at: Date;
};

const UPDATE_COLUMNS = `
  history.id, history.card_id, history.organization_id, history.board_id, history.user_id,
  history.update_type, history.message, history.metadata, history.created_at
`;

function mapUpdate(row: UpdateRow): CardUpdateRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    organizationId: row.organization_id,
    boardId: row.board_id,
    userId: row.user_id,
    updateType: row.update_type,
    message: row.message,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

type SubmissionRow = {
  id: string;
  card_id: string;
  organization_id: string;
  submitted_by: string;
  reviewed_by: string | null;
  submission_type: string;
  title: string;
  notes: string | null;
  link_url: string | null;
  file_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: string | number | null;
  approval_status: string;
  reviewed_at: Date | null;
  review_note: string | null;
  created_at: Date;
  updated_at: Date;
};

const SUBMISSION_RETURNING = `
  id, card_id, organization_id, submitted_by, reviewed_by, submission_type, title, notes,
  link_url, file_path, file_name, mime_type, file_size, approval_status, reviewed_at,
  review_note, created_at, updated_at
`;
const SUBMISSION_COLUMNS = `
  submission.id, submission.card_id, submission.organization_id, submission.submitted_by,
  submission.reviewed_by, submission.submission_type, submission.title, submission.notes,
  submission.link_url, submission.file_path, submission.file_name, submission.mime_type,
  submission.file_size, submission.approval_status, submission.reviewed_at,
  submission.review_note, submission.created_at, submission.updated_at
`;

function mapSubmission(row: SubmissionRow): SubmissionRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    organizationId: row.organization_id,
    submittedBy: row.submitted_by,
    reviewedBy: row.reviewed_by,
    submissionType: row.submission_type,
    title: row.title,
    notes: row.notes,
    linkUrl: row.link_url,
    filePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size == null ? null : Number(row.file_size),
    approvalStatus: row.approval_status,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type AttachmentRow = {
  id: string;
  card_id: string;
  organization_id: string;
  uploaded_by: string;
  bucket: string;
  object_key: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: string | number | null;
  checksum: string | null;
  created_at: Date;
};

const ATTACHMENT_RETURNING = `
  id, card_id, organization_id, uploaded_by, bucket, object_key, original_filename,
  content_type, size_bytes, checksum, created_at
`;
const ATTACHMENT_COLUMNS = `
  attachment.id, attachment.card_id, attachment.organization_id, attachment.uploaded_by,
  attachment.bucket, attachment.object_key, attachment.original_filename, attachment.content_type,
  attachment.size_bytes, attachment.checksum, attachment.created_at
`;

function mapAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    organizationId: row.organization_id,
    uploadedBy: row.uploaded_by,
    bucket: row.bucket,
    objectKey: row.object_key,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

type TimeEntryRow = {
  id: string;
  card_id: string;
  organization_id: string;
  user_id: string;
  created_by: string;
  seconds: number;
  note: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  is_billable: boolean;
  created_at: Date;
  updated_at: Date;
};

const TIME_ENTRY_RETURNING = `
  id, card_id, organization_id, user_id, created_by, seconds, note, started_at, ended_at,
  is_billable, created_at, updated_at
`;
const TIME_ENTRY_COLUMNS = `
  entry.id, entry.card_id, entry.organization_id, entry.user_id, entry.created_by,
  entry.seconds, entry.note, entry.started_at, entry.ended_at, entry.is_billable,
  entry.created_at, entry.updated_at
`;

function mapTimeEntry(row: TimeEntryRow): TimeEntryRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    createdBy: row.created_by,
    seconds: row.seconds,
    note: row.note,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    isBillable: row.is_billable,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresBoardStore implements WorkStore {
  async listByOrganization(organizationId: string) {
    const result = await db.query<BoardRow>(
      `
        SELECT ${BOARD_COLUMNS}
        FROM work.boards
        WHERE organization_id = $1
          AND archived_at IS NULL
        ORDER BY position ASC, created_at DESC
      `,
      [organizationId],
    );

    return result.rows.map(mapBoard);
  }

  async getById(organizationId: string, boardId: string) {
    const result = await db.query<BoardRow>(
      `
        SELECT ${BOARD_COLUMNS}
        FROM work.boards
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, boardId],
    );

    return result.rows[0] ? mapBoard(result.rows[0]) : null;
  }

  async create(input: CreateBoardInput) {
    const result = await db.query<BoardRow>(
      `
        INSERT INTO work.boards (
          id,
          organization_id,
          created_by,
          owner_id,
          name,
          slug,
          description,
          status,
          color,
          position,
          metadata,
          legacy_source,
          legacy_id
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb,
          'kode-platform',
          gen_random_uuid()
        )
        RETURNING ${BOARD_COLUMNS}
      `,
      [
        input.organizationId,
        input.createdBy,
        input.ownerId ?? null,
        input.name,
        input.slug ?? null,
        input.description ?? null,
        input.status ?? 'active',
        input.color ?? null,
        input.position ?? 0,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return mapBoard(result.rows[0]);
  }

  async update(
    organizationId: string,
    boardId: string,
    input: UpdateBoardInput,
  ) {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;

    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = $${index}`);
      values.push(value);
      index += 1;
    };

    if (input.name !== undefined) assign('name', input.name);
    if (input.slug !== undefined) assign('slug', input.slug);
    if (input.description !== undefined) assign('description', input.description);
    if (input.status !== undefined) assign('status', input.status);
    if (input.color !== undefined) assign('color', input.color);
    if (input.position !== undefined) assign('position', input.position);
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${index}::jsonb`);
      values.push(JSON.stringify(input.metadata));
      index += 1;
    }
    if (input.ownerId !== undefined) assign('owner_id', input.ownerId);

    values.push(organizationId, boardId);

    const result = await db.query<BoardRow>(
      `
        UPDATE work.boards
        SET ${sets.join(', ')}
        WHERE organization_id = $${index}
          AND id = $${index + 1}
        RETURNING ${BOARD_COLUMNS}
      `,
      values,
    );

    return result.rows[0] ? mapBoard(result.rows[0]) : null;
  }

  async listColumnsByBoard(organizationId: string, boardId: string) {
    const result = await db.query<ColumnRow>(
      `
        SELECT ${COLUMN_COLUMNS}
        FROM work.board_columns
        WHERE organization_id = $1
          AND board_id = $2
        ORDER BY position ASC, created_at ASC, id ASC
      `,
      [organizationId, boardId],
    );

    return result.rows.map(mapColumn);
  }

  async getColumnById(organizationId: string, columnId: string) {
    const result = await db.query<ColumnRow>(
      `
        SELECT
          c.id,
          c.organization_id,
          c.board_id,
          c.name,
          c.color,
          c.status_key,
          c.position,
          c.created_at,
          c.updated_at
        FROM work.board_columns c
        JOIN work.boards b
          ON b.id = c.board_id
         AND b.organization_id = c.organization_id
        WHERE c.organization_id = $1
          AND c.id = $2
      `,
      [organizationId, columnId],
    );

    return result.rows[0] ? mapColumn(result.rows[0]) : null;
  }

  async createColumn(input: CreateColumnInput) {
    const result = await db.query<ColumnRow>(
      `
        INSERT INTO work.board_columns (
          id,
          organization_id,
          board_id,
          name,
          color,
          status_key,
          position,
          created_at,
          updated_at,
          legacy_source,
          legacy_id
        )
        SELECT
          gen_random_uuid(),
          b.organization_id,
          b.id,
          $3,
          $4,
          $5,
          $6,
          NOW(),
          NOW(),
          'kode-platform',
          gen_random_uuid()
        FROM work.boards b
        WHERE b.organization_id = $1
          AND b.id = $2
        RETURNING ${COLUMN_COLUMNS}
      `,
      [
        input.organizationId,
        input.boardId,
        input.name,
        input.color ?? null,
        input.statusKey ?? null,
        input.position ?? 0,
      ],
    );

    return result.rows[0] ? mapColumn(result.rows[0]) : null;
  }

  async updateColumn(
    organizationId: string,
    columnId: string,
    input: UpdateColumnInput,
  ) {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;

    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = $${index}`);
      values.push(value);
      index += 1;
    };

    if (input.name !== undefined) assign('name', input.name);
    if (input.color !== undefined) assign('color', input.color);
    if (input.statusKey !== undefined) assign('status_key', input.statusKey);
    if (input.position !== undefined) assign('position', input.position);

    values.push(organizationId, columnId);

    const result = await db.query<ColumnRow>(
      `
        UPDATE work.board_columns c
        SET ${sets.join(', ')}
        FROM work.boards b
        WHERE c.organization_id = $${index}
          AND c.id = $${index + 1}
          AND b.id = c.board_id
          AND b.organization_id = c.organization_id
        RETURNING
          c.id,
          c.organization_id,
          c.board_id,
          c.name,
          c.color,
          c.status_key,
          c.position,
          c.created_at,
          c.updated_at
      `,
      values,
    );

    return result.rows[0] ? mapColumn(result.rows[0]) : null;
  }

  async listCardsByBoard(organizationId: string, boardId: string) {
    const result = await db.query<CardRow>(
      `
        SELECT ${CARD_COLUMNS}
        FROM work.cards card
        JOIN work.boards b
          ON b.id = card.board_id
         AND b.organization_id = card.organization_id
        WHERE card.organization_id = $1
          AND card.board_id = $2
        ORDER BY card.position ASC, card.created_at ASC, card.id ASC
      `,
      [organizationId, boardId],
    );

    return result.rows.map(mapCard);
  }

  async getCardById(organizationId: string, cardId: string) {
    const result = await db.query<CardRow>(
      `
        SELECT ${CARD_COLUMNS}
        FROM work.cards card
        JOIN work.boards b
          ON b.id = card.board_id
         AND b.organization_id = card.organization_id
        WHERE card.organization_id = $1
          AND card.id = $2
      `,
      [organizationId, cardId],
    );

    return result.rows[0] ? mapCard(result.rows[0]) : null;
  }

  async createCard(input: CreateCardInput) {
    const result = await db.query<CardRow>(
      `
        INSERT INTO work.cards (
          id,
          organization_id,
          board_id,
          column_id,
          created_by,
          title,
          description,
          status_key,
          priority,
          department,
          due_at,
          start_at,
          ai_generated,
          position,
          metadata,
          tracked_seconds_cache,
          is_billable,
          estimated_seconds,
          created_at,
          updated_at,
          legacy_source,
          legacy_id
        )
        SELECT
          gen_random_uuid(),
          b.organization_id,
          b.id,
          c.id,
          $4,
          $5,
          $6,
          COALESCE($7, c.status_key, 'todo'),
          COALESCE($8, 'normal'),
          $9,
          $10,
          $11,
          FALSE,
          COALESCE(
            $12,
            (
              SELECT COALESCE(MAX(existing.position) + 1, 0)
              FROM work.cards existing
              WHERE existing.organization_id = b.organization_id
                AND existing.board_id = b.id
                AND existing.column_id = c.id
            )
          ),
          $13::jsonb,
          0,
          COALESCE($14, FALSE),
          COALESCE($15, 0),
          NOW(),
          NOW(),
          'kode-platform',
          gen_random_uuid()
        FROM work.boards b
        JOIN work.board_columns c
          ON c.id = $3
         AND c.board_id = b.id
         AND c.organization_id = b.organization_id
        WHERE b.organization_id = $1
          AND b.id = $2
        RETURNING ${CARD_RETURNING}
      `,
      [
        input.organizationId,
        input.boardId,
        input.columnId,
        input.createdBy,
        input.title,
        input.description ?? null,
        input.statusKey ?? null,
        input.priority ?? null,
        input.department ?? null,
        input.dueAt ?? null,
        input.startAt ?? null,
        input.position ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.isBillable ?? null,
        input.estimatedSeconds ?? null,
      ],
    );

    const card = result.rows[0] ? mapCard(result.rows[0]) : null;
    if (card) {
      await this.insertCardUpdate(
        card,
        input.createdBy,
        'created',
        `Created card "${card.title}"`,
        { title: card.title },
      );
    }
    return card;
  }

  async updateCard(
    organizationId: string,
    cardId: string,
    input: UpdateCardInput,
    actorUserId?: string,
  ) {
    const before = actorUserId
      ? await this.getCardById(organizationId, cardId)
      : null;
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;
    let columnGuard = '';

    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = $${index}`);
      values.push(value);
      index += 1;
    };

    if (input.title !== undefined) assign('title', input.title);
    if (input.description !== undefined) assign('description', input.description);
    if (input.columnId !== undefined) {
      const columnParam = index;
      assign('column_id', input.columnId);
      columnGuard = `
          AND EXISTS (
            SELECT 1
            FROM work.board_columns dest
            WHERE dest.id = $${columnParam}
              AND dest.board_id = card.board_id
              AND dest.organization_id = card.organization_id
          )
      `;
    }
    if (input.statusKey !== undefined) assign('status_key', input.statusKey);
    if (input.priority !== undefined) assign('priority', input.priority);
    if (input.department !== undefined) assign('department', input.department);
    if (input.dueAt !== undefined) assign('due_at', input.dueAt);
    if (input.startAt !== undefined) assign('start_at', input.startAt);
    if (input.completedAt !== undefined) assign('completed_at', input.completedAt);
    if (input.blockedReason !== undefined) {
      assign('blocked_reason', input.blockedReason);
    }
    if (input.position !== undefined) assign('position', input.position);
    if (input.isBillable !== undefined) assign('is_billable', input.isBillable);
    if (input.estimatedSeconds !== undefined) {
      assign('estimated_seconds', input.estimatedSeconds);
    }
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${index}::jsonb`);
      values.push(JSON.stringify(input.metadata));
      index += 1;
    }

    values.push(organizationId, cardId);

    const result = await db.query<CardRow>(
      `
        UPDATE work.cards card
        SET ${sets.join(', ')}
        FROM work.boards b
        WHERE card.organization_id = $${index}
          AND card.id = $${index + 1}
          AND b.id = card.board_id
          AND b.organization_id = card.organization_id
          ${columnGuard}
        RETURNING ${CARD_COLUMNS}
      `,
      values,
    );

    const card = result.rows[0] ? mapCard(result.rows[0]) : null;
    if (card && before && actorUserId) {
      await this.recordCardFieldUpdates(before, card, actorUserId);
    }
    return card;
  }

  async getOrganizationMember(organizationId: string, userId: string) {
    const result = await db.query<{
      user_id: string;
      organization_id: string;
      status: string;
      account_status: string;
      is_active: boolean;
    }>(
      `
        SELECT
          m.user_id,
          m.organization_id,
          m.status,
          u.account_status,
          u.is_active
        FROM organizations.memberships m
        JOIN identity.users u
          ON u.id = m.user_id
        WHERE m.organization_id = $1
          AND m.user_id = $2
          AND m.status = 'active'
          AND u.is_active = TRUE
          AND u.account_status = 'active'
          AND u.deleted_at IS NULL
      `,
      [organizationId, userId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      organizationId: row.organization_id,
      status: row.status,
      accountStatus: row.account_status,
      isActive: row.is_active,
    } satisfies OrganizationMemberRecord;
  }

  async listCommentsByCard(organizationId: string, cardId: string) {
    const result = await db.query<CommentRow>(
      `
        SELECT ${COMMENT_COLUMNS}
        FROM work.card_comments comment
        JOIN work.cards card
          ON card.id = comment.card_id
         AND card.organization_id = comment.organization_id
        WHERE comment.organization_id = $1
          AND comment.card_id = $2
        ORDER BY comment.created_at ASC, comment.id ASC
      `,
      [organizationId, cardId],
    );
    return result.rows.map(mapComment);
  }

  async getCommentById(organizationId: string, commentId: string) {
    const result = await db.query<CommentRow>(
      `
        SELECT ${COMMENT_COLUMNS}
        FROM work.card_comments comment
        JOIN work.cards card
          ON card.id = comment.card_id
         AND card.organization_id = comment.organization_id
        WHERE comment.organization_id = $1
          AND comment.id = $2
      `,
      [organizationId, commentId],
    );
    return result.rows[0] ? mapComment(result.rows[0]) : null;
  }

  async createComment(input: CreateCommentInput) {
    const result = await db.query<CommentRow>(
      `
        INSERT INTO work.card_comments (
          id, card_id, organization_id, user_id, body, is_internal, comment_type,
          created_at, updated_at, legacy_source, legacy_id
        )
        SELECT
          gen_random_uuid(), card.id, card.organization_id, $3, $4, $5, $6,
          NOW(), NOW(), 'kode-platform', gen_random_uuid()
        FROM work.cards card
        JOIN work.boards b
          ON b.id = card.board_id
         AND b.organization_id = card.organization_id
        WHERE card.organization_id = $1
          AND card.id = $2
        RETURNING ${COMMENT_RETURNING}
      `,
      [
        input.organizationId,
        input.cardId,
        input.userId,
        input.body,
        input.isInternal ?? false,
        input.commentType ?? 'comment',
      ],
    );
    const comment = result.rows[0] ? mapComment(result.rows[0]) : null;
    if (comment) {
      const card = await this.getCardById(input.organizationId, input.cardId);
      if (card) {
        await this.insertCardUpdate(card, input.userId, 'commented', 'Added a comment');
      }
    }
    return comment;
  }

  async updateComment(
    organizationId: string,
    commentId: string,
    input: UpdateCommentInput,
  ) {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;
    if (input.body !== undefined) {
      sets.push(`body = $${index}`);
      values.push(input.body);
      index += 1;
    }
    if (input.isInternal !== undefined) {
      sets.push(`is_internal = $${index}`);
      values.push(input.isInternal);
      index += 1;
    }
    values.push(organizationId, commentId);
    const result = await db.query<CommentRow>(
      `
        UPDATE work.card_comments comment
        SET ${sets.join(', ')}
        FROM work.cards card
        WHERE comment.organization_id = $${index}
          AND comment.id = $${index + 1}
          AND card.id = comment.card_id
          AND card.organization_id = comment.organization_id
        RETURNING ${COMMENT_COLUMNS}
      `,
      values,
    );
    return result.rows[0] ? mapComment(result.rows[0]) : null;
  }

  async listLabels(organizationId: string) {
    const result = await db.query<LabelRow>(
      `
        SELECT ${LABEL_RETURNING}
        FROM work.labels
        WHERE organization_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [organizationId],
    );
    return result.rows.map(mapLabel);
  }

  async getLabelById(organizationId: string, labelId: string) {
    const result = await db.query<LabelRow>(
      `
        SELECT ${LABEL_RETURNING}
        FROM work.labels
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, labelId],
    );
    return result.rows[0] ? mapLabel(result.rows[0]) : null;
  }

  async createLabel(input: CreateLabelInput) {
    const result = await db.query<LabelRow>(
      `
        INSERT INTO work.labels (
          id, organization_id, name, color, created_at, legacy_source, legacy_id
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, NOW(), 'kode-platform', gen_random_uuid()
        )
        RETURNING ${LABEL_RETURNING}
      `,
      [input.organizationId, input.name, input.color],
    );
    return mapLabel(result.rows[0]);
  }

  async updateLabel(
    organizationId: string,
    labelId: string,
    input: UpdateLabelInput,
  ) {
    const sets: string[] = [];
    const values: unknown[] = [];
    let index = 1;
    if (input.name !== undefined) {
      sets.push(`name = $${index}`);
      values.push(input.name);
      index += 1;
    }
    if (input.color !== undefined) {
      sets.push(`color = $${index}`);
      values.push(input.color);
      index += 1;
    }
    if (sets.length === 0) {
      return this.getLabelById(organizationId, labelId);
    }
    values.push(organizationId, labelId);
    const result = await db.query<LabelRow>(
      `
        UPDATE work.labels
        SET ${sets.join(', ')}
        WHERE organization_id = $${index}
          AND id = $${index + 1}
        RETURNING ${LABEL_RETURNING}
      `,
      values,
    );
    return result.rows[0] ? mapLabel(result.rows[0]) : null;
  }

  async listCardLabels(organizationId: string, cardId: string) {
    const result = await db.query<CardLabelRow>(
      `
        SELECT
          a.id,
          a.card_id,
          a.label_id,
          l.organization_id,
          l.name,
          l.color,
          a.created_at
        FROM work.card_label_assignments a
        JOIN work.labels l
          ON l.id = a.label_id
        JOIN work.cards card
          ON card.id = a.card_id
         AND card.organization_id = l.organization_id
        WHERE card.organization_id = $1
          AND card.id = $2
        ORDER BY a.created_at ASC, a.id ASC
      `,
      [organizationId, cardId],
    );
    return result.rows.map(mapCardLabel);
  }

  async assignCardLabel(
    organizationId: string,
    cardId: string,
    labelId: string,
    actorUserId: string,
  ) {
    try {
      const result = await db.query<CardLabelRow>(
        `
          INSERT INTO work.card_label_assignments (
            id, card_id, label_id, created_at, legacy_source, legacy_id
          )
          SELECT
            gen_random_uuid(), card.id, label.id, NOW(), 'kode-platform', gen_random_uuid()
          FROM work.cards card
          JOIN work.labels label
            ON label.organization_id = card.organization_id
          JOIN work.boards b
            ON b.id = card.board_id
           AND b.organization_id = card.organization_id
          WHERE card.organization_id = $1
            AND card.id = $2
            AND label.id = $3
          RETURNING
            id, card_id, label_id,
            $1::uuid AS organization_id,
            (SELECT name FROM work.labels WHERE id = $3) AS name,
            (SELECT color FROM work.labels WHERE id = $3) AS color,
            created_at
        `,
        [organizationId, cardId, labelId],
      );
      const assignment = result.rows[0] ? mapCardLabel(result.rows[0]) : null;
      if (assignment) {
        const card = await this.getCardById(organizationId, cardId);
        if (card) {
          await this.insertCardUpdate(
            card,
            actorUserId,
            'label_added',
            `Added label "${assignment.name}"`,
            { labelId },
          );
        }
      }
      return assignment;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'duplicate';
      }
      throw error;
    }
  }

  async removeCardLabel(
    organizationId: string,
    cardId: string,
    labelId: string,
    actorUserId: string,
  ) {
    const result = await db.query<{ name: string }>(
      `
        DELETE FROM work.card_label_assignments a
        USING work.cards card, work.labels label
        WHERE a.card_id = card.id
          AND a.label_id = label.id
          AND card.organization_id = $1
          AND card.id = $2
          AND label.id = $3
          AND label.organization_id = card.organization_id
        RETURNING label.name
      `,
      [organizationId, cardId, labelId],
    );
    if (!result.rows[0]) {
      return false;
    }
    const card = await this.getCardById(organizationId, cardId);
    if (card) {
      await this.insertCardUpdate(
        card,
        actorUserId,
        'label_removed',
        `Removed label "${result.rows[0].name}"`,
        { labelId },
      );
    }
    return true;
  }

  async listWatchers(organizationId: string, cardId: string) {
    const result = await db.query<WatcherRow>(
      `
        SELECT ${WATCHER_COLUMNS}
        FROM work.card_watchers watcher
        JOIN work.cards card
          ON card.id = watcher.card_id
         AND card.organization_id = watcher.organization_id
        WHERE watcher.organization_id = $1
          AND watcher.card_id = $2
        ORDER BY watcher.created_at ASC, watcher.id ASC
      `,
      [organizationId, cardId],
    );
    return result.rows.map(mapWatcher);
  }

  async addWatcher(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ) {
    const member = await this.getOrganizationMember(organizationId, userId);
    if (!member) {
      return null;
    }
    try {
      const result = await db.query<WatcherRow>(
        `
          INSERT INTO work.card_watchers (
            id, card_id, user_id, organization_id, created_at, legacy_source, legacy_id
          )
          SELECT
            gen_random_uuid(), card.id, $3, card.organization_id, NOW(),
            'kode-platform', gen_random_uuid()
          FROM work.cards card
          JOIN work.boards b
            ON b.id = card.board_id
           AND b.organization_id = card.organization_id
          WHERE card.organization_id = $1
            AND card.id = $2
          RETURNING ${WATCHER_RETURNING}
        `,
        [organizationId, cardId, userId],
      );
      const watcher = result.rows[0] ? mapWatcher(result.rows[0]) : null;
      if (watcher) {
        const card = await this.getCardById(organizationId, cardId);
        if (card) {
          await this.insertCardUpdate(card, actorUserId, 'watcher_added', 'Added a watcher', {
            userId,
          });
        }
      }
      return watcher;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'duplicate';
      }
      throw error;
    }
  }

  async removeWatcher(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ) {
    const result = await db.query(
      `
        DELETE FROM work.card_watchers watcher
        USING work.cards card
        WHERE watcher.card_id = card.id
          AND watcher.organization_id = card.organization_id
          AND watcher.organization_id = $1
          AND watcher.card_id = $2
          AND watcher.user_id = $3
        RETURNING watcher.id
      `,
      [organizationId, cardId, userId],
    );
    if (result.rowCount === 0) {
      return false;
    }
    const card = await this.getCardById(organizationId, cardId);
    if (card) {
      await this.insertCardUpdate(card, actorUserId, 'watcher_removed', 'Removed a watcher', {
        userId,
      });
    }
    return true;
  }

  async listAssignees(organizationId: string, cardId: string) {
    const result = await db.query<AssigneeRow>(
      `
        SELECT ${ASSIGNEE_COLUMNS}
        FROM work.card_assignees assignee
        JOIN work.cards card
          ON card.id = assignee.card_id
         AND card.organization_id = assignee.organization_id
        WHERE assignee.organization_id = $1
          AND assignee.card_id = $2
        ORDER BY assignee.created_at ASC, assignee.id ASC
      `,
      [organizationId, cardId],
    );
    return result.rows.map(mapAssignee);
  }

  async addAssignee(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ) {
    const member = await this.getOrganizationMember(organizationId, userId);
    if (!member) {
      return null;
    }
    try {
      const result = await db.query<AssigneeRow>(
        `
          INSERT INTO work.card_assignees (
            id, card_id, user_id, organization_id, created_at, legacy_source, legacy_id
          )
          SELECT
            gen_random_uuid(), card.id, $3, card.organization_id, NOW(),
            'kode-platform', gen_random_uuid()
          FROM work.cards card
          JOIN work.boards b
            ON b.id = card.board_id
           AND b.organization_id = card.organization_id
          WHERE card.organization_id = $1
            AND card.id = $2
          RETURNING ${ASSIGNEE_RETURNING}
        `,
        [organizationId, cardId, userId],
      );
      const assignee = result.rows[0] ? mapAssignee(result.rows[0]) : null;
      if (assignee) {
        await db.query(
          `
            UPDATE work.cards
            SET assigned_to = COALESCE(assigned_to, $3),
                assigned_by = COALESCE(assigned_by, $4),
                updated_at = NOW()
            WHERE organization_id = $1
              AND id = $2
          `,
          [organizationId, cardId, userId, actorUserId],
        );
        const card = await this.getCardById(organizationId, cardId);
        if (card) {
          await this.insertCardUpdate(card, actorUserId, 'assigned', 'Assigned a member', {
            userId,
          });
        }
      }
      return assignee;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'duplicate';
      }
      throw error;
    }
  }

  async removeAssignee(
    organizationId: string,
    cardId: string,
    userId: string,
    actorUserId: string,
  ) {
    const result = await db.query(
      `
        DELETE FROM work.card_assignees assignee
        USING work.cards card
        WHERE assignee.card_id = card.id
          AND assignee.organization_id = card.organization_id
          AND assignee.organization_id = $1
          AND assignee.card_id = $2
          AND assignee.user_id = $3
        RETURNING assignee.id
      `,
      [organizationId, cardId, userId],
    );
    if (result.rowCount === 0) {
      return false;
    }
    await db.query(
      `
        UPDATE work.cards card
        SET assigned_to = (
              SELECT assignee.user_id
              FROM work.card_assignees assignee
              WHERE assignee.card_id = card.id
              ORDER BY assignee.created_at ASC
              LIMIT 1
            ),
            assigned_by = CASE
              WHEN assigned_to = $3 THEN NULL
              ELSE assigned_by
            END,
            updated_at = NOW()
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, cardId, userId],
    );
    const card = await this.getCardById(organizationId, cardId);
    if (card) {
      await this.insertCardUpdate(card, actorUserId, 'unassigned', 'Removed an assignee', {
        userId,
      });
    }
    return true;
  }

  async listCardUpdates(organizationId: string, cardId: string) {
    const result = await db.query<UpdateRow>(
      `
        SELECT ${UPDATE_COLUMNS}
        FROM work.card_updates history
        JOIN work.cards card
          ON card.id = history.card_id
         AND card.organization_id = history.organization_id
        WHERE history.organization_id = $1
          AND history.card_id = $2
        ORDER BY history.created_at ASC, history.id ASC
      `,
      [organizationId, cardId],
    );
    return result.rows.map(mapUpdate);
  }

  async listSubmissionsByCard(organizationId: string, cardId: string) {
    const result = await db.query<SubmissionRow>(
      `
        SELECT ${SUBMISSION_COLUMNS}
        FROM work.card_submissions submission
        JOIN work.cards card
          ON card.id = submission.card_id
         AND card.organization_id = submission.organization_id
        WHERE submission.organization_id = $1
          AND submission.card_id = $2
        ORDER BY submission.created_at ASC, submission.id ASC
      `,
      [organizationId, cardId],
    );
    return result.rows.map(mapSubmission);
  }

  async getSubmissionById(organizationId: string, submissionId: string) {
    const result = await db.query<SubmissionRow>(
      `
        SELECT ${SUBMISSION_COLUMNS}
        FROM work.card_submissions submission
        JOIN work.cards card
          ON card.id = submission.card_id
         AND card.organization_id = submission.organization_id
        WHERE submission.organization_id = $1
          AND submission.id = $2
      `,
      [organizationId, submissionId],
    );
    return result.rows[0] ? mapSubmission(result.rows[0]) : null;
  }

  async createSubmission(input: CreateSubmissionInput) {
    const result = await db.query<SubmissionRow>(
      `
        INSERT INTO work.card_submissions (
          id, card_id, organization_id, submitted_by, submission_type, title, notes,
          link_url, file_name, mime_type, file_size, approval_status,
          created_at, updated_at, legacy_source, legacy_id
        )
        SELECT
          gen_random_uuid(), card.id, card.organization_id, $3, $4, $5, $6,
          $7, $8, $9, $10, 'pending', NOW(), NOW(), 'kode-platform', gen_random_uuid()
        FROM work.cards card
        JOIN work.boards b
          ON b.id = card.board_id
         AND b.organization_id = card.organization_id
        WHERE card.organization_id = $1
          AND card.id = $2
        RETURNING ${SUBMISSION_RETURNING}
      `,
      [
        input.organizationId,
        input.cardId,
        input.submittedBy,
        input.submissionType ?? (input.linkUrl ? 'link' : 'note'),
        input.title,
        input.notes ?? null,
        input.linkUrl ?? null,
        input.fileName ?? null,
        input.mimeType ?? null,
        input.fileSize ?? null,
      ],
    );
    const submission = result.rows[0] ? mapSubmission(result.rows[0]) : null;
    if (submission) {
      const card = await this.getCardById(input.organizationId, input.cardId);
      if (card) {
        await this.insertCardUpdate(
          card,
          input.submittedBy,
          'submission_created',
          `Submitted "${submission.title}"`,
        );
      }
    }
    return submission;
  }

  async updateSubmission(
    organizationId: string,
    submissionId: string,
    input: UpdateSubmissionInput,
  ) {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;
    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = $${index}`);
      values.push(value);
      index += 1;
    };
    if (input.title !== undefined) assign('title', input.title);
    if (input.notes !== undefined) assign('notes', input.notes);
    if (input.linkUrl !== undefined) assign('link_url', input.linkUrl);
    if (input.approvalStatus !== undefined) assign('approval_status', input.approvalStatus);
    if (input.reviewNote !== undefined) assign('review_note', input.reviewNote);
    if (input.reviewedBy !== undefined) assign('reviewed_by', input.reviewedBy);
    if (input.reviewedAt !== undefined) assign('reviewed_at', input.reviewedAt);
    values.push(organizationId, submissionId);
    const result = await db.query<SubmissionRow>(
      `
        UPDATE work.card_submissions submission
        SET ${sets.join(', ')}
        FROM work.cards card
        WHERE submission.organization_id = $${index}
          AND submission.id = $${index + 1}
          AND card.id = submission.card_id
          AND card.organization_id = submission.organization_id
        RETURNING ${SUBMISSION_COLUMNS}
      `,
      values,
    );
    return result.rows[0] ? mapSubmission(result.rows[0]) : null;
  }

  async listAttachmentsByCard(organizationId: string, cardId: string) {
    const result = await db.query<AttachmentRow>(
      `
        SELECT ${ATTACHMENT_COLUMNS}
        FROM work.card_attachments attachment
        JOIN work.cards card
          ON card.id = attachment.card_id
         AND card.organization_id = attachment.organization_id
        WHERE attachment.organization_id = $1
          AND attachment.card_id = $2
        ORDER BY attachment.created_at ASC, attachment.id ASC
      `,
      [organizationId, cardId],
    );
    return result.rows.map(mapAttachment);
  }

  async getAttachmentById(organizationId: string, attachmentId: string) {
    const result = await db.query<AttachmentRow>(
      `
        SELECT ${ATTACHMENT_COLUMNS}
        FROM work.card_attachments attachment
        JOIN work.cards card
          ON card.id = attachment.card_id
         AND card.organization_id = attachment.organization_id
        WHERE attachment.organization_id = $1
          AND attachment.id = $2
      `,
      [organizationId, attachmentId],
    );
    return result.rows[0] ? mapAttachment(result.rows[0]) : null;
  }

  async createAttachment(input: CreateAttachmentInput) {
    const result = await db.query<AttachmentRow>(
      `
        INSERT INTO work.card_attachments (
          id, card_id, organization_id, uploaded_by, bucket, object_key,
          original_filename, content_type, size_bytes, checksum, created_at
        )
        SELECT
          $3, card.id, card.organization_id, $4, $5, $6, $7, $8, $9, $10, NOW()
        FROM work.cards card
        JOIN work.boards b
          ON b.id = card.board_id
         AND b.organization_id = card.organization_id
        WHERE card.organization_id = $1
          AND card.id = $2
        RETURNING ${ATTACHMENT_RETURNING}
      `,
      [
        input.organizationId,
        input.cardId,
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
    const attachment = result.rows[0] ? mapAttachment(result.rows[0]) : null;
    if (attachment) {
      const card = await this.getCardById(input.organizationId, input.cardId);
      if (card) {
        await this.insertCardUpdate(
          card,
          input.uploadedBy,
          'attachment_added',
          `Attached "${attachment.originalFilename}"`,
        );
      }
    }
    return attachment;
  }

  async deleteAttachment(organizationId: string, attachmentId: string) {
    const current = await this.getAttachmentById(organizationId, attachmentId);
    if (!current) {
      return null;
    }
    await db.query(
      `
        DELETE FROM work.card_attachments
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, attachmentId],
    );
    return current;
  }

  async listTimeEntriesByCard(organizationId: string, cardId: string) {
    const result = await db.query<TimeEntryRow>(
      `
        SELECT ${TIME_ENTRY_COLUMNS}
        FROM work.time_entries entry
        JOIN work.cards card
          ON card.id = entry.card_id
         AND card.organization_id = entry.organization_id
        WHERE entry.organization_id = $1
          AND entry.card_id = $2
        ORDER BY entry.created_at ASC, entry.id ASC
      `,
      [organizationId, cardId],
    );
    return result.rows.map(mapTimeEntry);
  }

  async getTimeEntryById(organizationId: string, timeEntryId: string) {
    const result = await db.query<TimeEntryRow>(
      `
        SELECT ${TIME_ENTRY_COLUMNS}
        FROM work.time_entries entry
        JOIN work.cards card
          ON card.id = entry.card_id
         AND card.organization_id = entry.organization_id
        WHERE entry.organization_id = $1
          AND entry.id = $2
      `,
      [organizationId, timeEntryId],
    );
    return result.rows[0] ? mapTimeEntry(result.rows[0]) : null;
  }

  async createTimeEntry(input: CreateTimeEntryInput) {
    const member = await this.getOrganizationMember(
      input.organizationId,
      input.userId,
    );
    if (!member) {
      return null;
    }
    const result = await db.query<TimeEntryRow>(
      `
        INSERT INTO work.time_entries (
          id, card_id, organization_id, user_id, created_by, seconds, note,
          started_at, ended_at, is_billable, created_at, updated_at
        )
        SELECT
          gen_random_uuid(), card.id, card.organization_id, $3, $4, $5, $6,
          $7, $8, COALESCE($9, FALSE), NOW(), NOW()
        FROM work.cards card
        JOIN work.boards b
          ON b.id = card.board_id
         AND b.organization_id = card.organization_id
        WHERE card.organization_id = $1
          AND card.id = $2
        RETURNING ${TIME_ENTRY_RETURNING}
      `,
      [
        input.organizationId,
        input.cardId,
        input.userId,
        input.createdBy,
        input.seconds,
        input.note ?? null,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.isBillable ?? null,
      ],
    );
    const entry = result.rows[0] ? mapTimeEntry(result.rows[0]) : null;
    if (entry) {
      await this.refreshTrackedSeconds(input.organizationId, input.cardId);
      const card = await this.getCardById(input.organizationId, input.cardId);
      if (card) {
        await this.insertCardUpdate(card, input.createdBy, 'time_logged', 'Logged time', {
          seconds: input.seconds,
        });
      }
    }
    return entry;
  }

  async updateTimeEntry(
    organizationId: string,
    timeEntryId: string,
    input: UpdateTimeEntryInput,
  ) {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;
    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = $${index}`);
      values.push(value);
      index += 1;
    };
    if (input.seconds !== undefined) assign('seconds', input.seconds);
    if (input.note !== undefined) assign('note', input.note);
    if (input.startedAt !== undefined) assign('started_at', input.startedAt);
    if (input.endedAt !== undefined) assign('ended_at', input.endedAt);
    if (input.isBillable !== undefined) assign('is_billable', input.isBillable);
    values.push(organizationId, timeEntryId);
    const result = await db.query<TimeEntryRow>(
      `
        UPDATE work.time_entries entry
        SET ${sets.join(', ')}
        FROM work.cards card
        WHERE entry.organization_id = $${index}
          AND entry.id = $${index + 1}
          AND card.id = entry.card_id
          AND card.organization_id = entry.organization_id
        RETURNING ${TIME_ENTRY_COLUMNS}
      `,
      values,
    );
    const entry = result.rows[0] ? mapTimeEntry(result.rows[0]) : null;
    if (entry) {
      await this.refreshTrackedSeconds(organizationId, entry.cardId);
    }
    return entry;
  }

  private async refreshTrackedSeconds(organizationId: string, cardId: string) {
    await db.query(
      `
        UPDATE work.cards card
        SET tracked_seconds_cache = COALESCE((
          SELECT SUM(entry.seconds)
          FROM work.time_entries entry
          WHERE entry.organization_id = card.organization_id
            AND entry.card_id = card.id
        ), 0)
        WHERE card.organization_id = $1
          AND card.id = $2
      `,
      [organizationId, cardId],
    );
  }

  private async recordCardFieldUpdates(
    before: CardRecord,
    after: CardRecord,
    actorUserId: string,
  ) {
    if (before.title !== after.title) {
      await this.insertCardUpdate(
        after,
        actorUserId,
        'title_changed',
        `Renamed card to "${after.title}"`,
        { from: before.title, to: after.title },
      );
    }
    if (before.description !== after.description) {
      await this.insertCardUpdate(after, actorUserId, 'description_changed', 'Updated description');
    }
    if (before.columnId !== after.columnId) {
      await this.insertCardUpdate(after, actorUserId, 'column_moved', 'Moved card to another column', {
        from: before.columnId,
        to: after.columnId,
      });
    }
    if (before.statusKey !== after.statusKey) {
      await this.insertCardUpdate(
        after,
        actorUserId,
        'status_changed',
        `Changed status to ${after.statusKey}`,
        { from: before.statusKey, to: after.statusKey },
      );
    }
    if (before.priority !== after.priority) {
      await this.insertCardUpdate(
        after,
        actorUserId,
        'priority_changed',
        `Changed priority to ${after.priority}`,
        { from: before.priority, to: after.priority },
      );
    }
    if (before.completedAt?.getTime() !== after.completedAt?.getTime()) {
      await this.insertCardUpdate(
        after,
        actorUserId,
        after.completedAt ? 'completed' : 'reopened',
        after.completedAt ? 'Marked card completed' : 'Cleared completion',
      );
    }
  }

  private async insertCardUpdate(
    card: CardRecord,
    userId: string | null,
    updateType: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ) {
    await db.query(
      `
        INSERT INTO work.card_updates (
          id, card_id, organization_id, board_id, user_id, update_type, message,
          metadata, created_at, legacy_source, legacy_id
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, NOW(),
          'kode-platform', gen_random_uuid()
        )
      `,
      [
        card.id,
        card.organizationId,
        card.boardId,
        userId,
        updateType,
        message,
        JSON.stringify(metadata),
      ],
    );
  }
}
