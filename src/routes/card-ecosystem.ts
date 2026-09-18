import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { env } from '../config/env.js';
import type { FileStorage } from '../files/storage.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { decodeStrictBase64 } from '../http/base64.js';
import { FIELD_LIMITS } from '../http/limits.js';
import { rateLimitWork, type WorkRateLimitKind } from '../http/work-rate-limit.js';
import {
  assertCommentOwner,
  readJson,
  readOptionalBoolean,
  readOptionalInteger,
  readOptionalString,
  readOptionalTimestamp,
  readRequiredText,
  rejectIdentityOverrides,
  requireCardInOrganization,
  requireId,
  requireOrganizationMember,
  requireUuidValue,
} from '../work/http.js';
import type {
  AssigneeRecord,
  AttachmentRecord,
  CardLabelRecord,
  CardUpdateRecord,
  ChecklistItemRecord,
  ChecklistRecord,
  CommentRecord,
  LabelRecord,
  SubmissionRecord,
  TimeEntryRecord,
  UpdateChecklistInput,
  UpdateChecklistItemInput,
  UpdateCommentInput,
  UpdateLabelInput,
  UpdateSubmissionInput,
  UpdateTimeEntryInput,
  WatcherRecord,
  WorkStore,
} from '../work/store.js';

export type CardEcosystemDependencies = {
  store: WorkStore;
  files: FileStorage;
};

function serializeComment(comment: CommentRecord) {
  return {
    id: comment.id,
    cardId: comment.cardId,
    organizationId: comment.organizationId,
    userId: comment.userId,
    body: comment.body,
    isInternal: comment.isInternal,
    commentType: comment.commentType,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

function serializeLabel(label: LabelRecord) {
  return {
    id: label.id,
    organizationId: label.organizationId,
    name: label.name,
    color: label.color,
    createdAt: label.createdAt.toISOString(),
  };
}

function serializeCardLabel(label: CardLabelRecord) {
  return {
    id: label.id,
    cardId: label.cardId,
    labelId: label.labelId,
    organizationId: label.organizationId,
    name: label.name,
    color: label.color,
    createdAt: label.createdAt.toISOString(),
  };
}

function serializeWatcher(watcher: WatcherRecord) {
  return {
    id: watcher.id,
    cardId: watcher.cardId,
    organizationId: watcher.organizationId,
    userId: watcher.userId,
    createdAt: watcher.createdAt.toISOString(),
  };
}

function serializeAssignee(assignee: AssigneeRecord) {
  return {
    id: assignee.id,
    cardId: assignee.cardId,
    organizationId: assignee.organizationId,
    userId: assignee.userId,
    createdAt: assignee.createdAt.toISOString(),
  };
}

function serializeUpdate(update: CardUpdateRecord) {
  return {
    id: update.id,
    cardId: update.cardId,
    organizationId: update.organizationId,
    boardId: update.boardId,
    userId: update.userId,
    updateType: update.updateType,
    message: update.message,
    metadata: update.metadata,
    createdAt: update.createdAt.toISOString(),
  };
}

function serializeSubmission(submission: SubmissionRecord) {
  return {
    id: submission.id,
    cardId: submission.cardId,
    organizationId: submission.organizationId,
    submittedBy: submission.submittedBy,
    reviewedBy: submission.reviewedBy,
    submissionType: submission.submissionType,
    title: submission.title,
    notes: submission.notes,
    linkUrl: submission.linkUrl,
    fileName: submission.fileName,
    mimeType: submission.mimeType,
    fileSize: submission.fileSize,
    approvalStatus: submission.approvalStatus,
    reviewedAt: submission.reviewedAt?.toISOString() ?? null,
    reviewNote: submission.reviewNote,
    createdAt: submission.createdAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString(),
  };
}

function serializeAttachment(attachment: AttachmentRecord) {
  return {
    id: attachment.id,
    cardId: attachment.cardId,
    organizationId: attachment.organizationId,
    uploadedBy: attachment.uploadedBy,
    originalFilename: attachment.originalFilename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    checksum: attachment.checksum,
    createdAt: attachment.createdAt.toISOString(),
  };
}

function serializeTimeEntry(entry: TimeEntryRecord) {
  return {
    id: entry.id,
    cardId: entry.cardId,
    organizationId: entry.organizationId,
    userId: entry.userId,
    createdBy: entry.createdBy,
    seconds: entry.seconds,
    note: entry.note,
    startedAt: entry.startedAt?.toISOString() ?? null,
    endedAt: entry.endedAt?.toISOString() ?? null,
    isBillable: entry.isBillable,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

function serializeChecklistItem(item: ChecklistItemRecord) {
  return {
    id: item.id,
    checklistId: item.checklistId,
    cardId: item.cardId,
    organizationId: item.organizationId,
    createdBy: item.createdBy,
    completedBy: item.completedBy,
    content: item.content,
    isCompleted: item.isCompleted,
    completedAt: item.completedAt?.toISOString() ?? null,
    position: item.position,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function serializeChecklist(checklist: ChecklistRecord) {
  return {
    id: checklist.id,
    cardId: checklist.cardId,
    organizationId: checklist.organizationId,
    createdBy: checklist.createdBy,
    title: checklist.title,
    position: checklist.position,
    createdAt: checklist.createdAt.toISOString(),
    updatedAt: checklist.updatedAt.toISOString(),
    items: checklist.items.map(serializeChecklistItem),
  };
}

function readOptionalPosition(value: unknown): number | undefined {
  const position = readOptionalInteger(value, 'position');
  if (position !== undefined && position < 0) {
    throw new ValidationError('position must be at least 0.', { field: 'position' });
  }
  return position;
}

function authorize(
  auth: ReturnType<typeof getAuth>,
  action: string,
  type: string,
  organizationId: string,
  id?: string,
) {
  assertAuthorized({
    context: auth,
    action,
    resource: {
      type,
      organizationId,
      ...(id ? { id } : {}),
    },
  });
}

async function authorizeMutation(
  c: Parameters<typeof rateLimitWork>[0],
  auth: ReturnType<typeof getAuth>,
  action: string,
  type: string,
  organizationId: string,
  id?: string,
  kind: WorkRateLimitKind = 'mutation',
) {
  authorize(auth, action, type, organizationId, id);
  await rateLimitWork(c, kind);
}

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

function resultOrConflict<T>(
  result: T | 'duplicate' | null,
  missing: { code: string; message: string },
  duplicate: { code: string; message: string },
) {
  if (result === 'duplicate') {
    throw new ConflictError(duplicate.code, duplicate.message);
  }

  if (!result) {
    throw new NotFoundError(missing.code, missing.message);
  }

  return result;
}

export function createCardNestedRoutes(dependencies: CardEcosystemDependencies) {
  const routes = new Hono();

  routes.get('/:cardId/comments', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.card_comments.read', 'work.card_comment', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const comments = await dependencies.store.listCommentsByCard(organizationId, cardId);
    return c.json({ comments: comments.map(serializeComment) });
  });

  routes.post('/:cardId/comments', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    await authorizeMutation(c, auth, 'work.card_comments.create', 'work.card_comment', organizationId, cardId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const comment = await dependencies.store.createComment({
      organizationId,
      cardId,
      userId: auth.actor.userId,
      body: readRequiredText(body.body, 'body', FIELD_LIMITS.commentBody),
      isInternal: readOptionalBoolean(body.isInternal ?? body.is_internal, 'isInternal') ?? false,
      commentType:
        readOptionalString(
          body.commentType ?? body.comment_type,
          'commentType',
          FIELD_LIMITS.commentType,
        ) ?? 'comment',
    });
    if (!comment) {
      throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
    }
    return c.json({ comment: serializeComment(comment) }, 201);
  });

  routes.get('/:cardId/labels', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.card_labels.read', 'work.card_label', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const labels = await dependencies.store.listCardLabels(organizationId, cardId);
    return c.json({ labels: labels.map(serializeCardLabel) });
  });

  routes.post('/:cardId/labels', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    await authorizeMutation(c, auth, 'work.card_labels.create', 'work.card_label', organizationId, cardId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const labelId = requireUuidValue(body.labelId ?? body.label_id, 'labelId');
    const assigned = resultOrConflict(
      await dependencies.store.assignCardLabel(
        organizationId,
        cardId,
        labelId,
        auth.actor.userId,
      ),
      { code: 'LABEL_NOT_FOUND', message: 'The label was not found.' },
      { code: 'CARD_LABEL_EXISTS', message: 'The label is already assigned to this card.' },
    );
    return c.json({ label: serializeCardLabel(assigned) }, 201);
  });

  routes.delete('/:cardId/labels/:labelId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    const labelId = requireId(c.req.param('labelId'), 'labelId');
    await authorizeMutation(c, auth, 'work.card_labels.delete', 'work.card_label', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const removed = await dependencies.store.removeCardLabel(
      organizationId,
      cardId,
      labelId,
      auth.actor.userId,
    );
    if (!removed) {
      throw new NotFoundError('CARD_LABEL_NOT_FOUND', 'The card label was not found.');
    }
    return c.body(null, 204);
  });

  routes.get('/:cardId/watchers', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.card_watchers.read', 'work.card_watcher', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const watchers = await dependencies.store.listWatchers(organizationId, cardId);
    return c.json({ watchers: watchers.map(serializeWatcher) });
  });

  routes.post('/:cardId/watchers', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    await authorizeMutation(c, auth, 'work.card_watchers.create', 'work.card_watcher', organizationId, cardId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const userId = requireUuidValue(body.userId ?? body.user_id, 'userId');
    await requireOrganizationMember(dependencies.store, organizationId, userId);
    const watcher = resultOrConflict(
      await dependencies.store.addWatcher(
        organizationId,
        cardId,
        userId,
        auth.actor.userId,
      ),
      { code: 'CARD_NOT_FOUND', message: 'The card was not found.' },
      { code: 'WATCHER_EXISTS', message: 'The user is already watching this card.' },
    );
    return c.json({ watcher: serializeWatcher(watcher) }, 201);
  });

  routes.delete('/:cardId/watchers/:userId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    const userId = requireId(c.req.param('userId'), 'userId');
    await authorizeMutation(c, auth, 'work.card_watchers.delete', 'work.card_watcher', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const removed = await dependencies.store.removeWatcher(
      organizationId,
      cardId,
      userId,
      auth.actor.userId,
    );
    if (!removed) {
      throw new NotFoundError('WATCHER_NOT_FOUND', 'The watcher was not found.');
    }
    return c.body(null, 204);
  });

  routes.get('/:cardId/assignees', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.card_assignees.read', 'work.card_assignee', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const assignees = await dependencies.store.listAssignees(organizationId, cardId);
    return c.json({ assignees: assignees.map(serializeAssignee) });
  });

  routes.post('/:cardId/assignees', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    await authorizeMutation(c, auth, 'work.card_assignees.create', 'work.card_assignee', organizationId, cardId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const userId = requireUuidValue(body.userId ?? body.user_id, 'userId');
    await requireOrganizationMember(dependencies.store, organizationId, userId);
    const assignee = resultOrConflict(
      await dependencies.store.addAssignee(
        organizationId,
        cardId,
        userId,
        auth.actor.userId,
      ),
      { code: 'CARD_NOT_FOUND', message: 'The card was not found.' },
      { code: 'ASSIGNEE_EXISTS', message: 'The user is already assigned to this card.' },
    );
    return c.json({ assignee: serializeAssignee(assignee) }, 201);
  });

  routes.delete('/:cardId/assignees/:userId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    const userId = requireId(c.req.param('userId'), 'userId');
    await authorizeMutation(c, auth, 'work.card_assignees.delete', 'work.card_assignee', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const removed = await dependencies.store.removeAssignee(
      organizationId,
      cardId,
      userId,
      auth.actor.userId,
    );
    if (!removed) {
      throw new NotFoundError('ASSIGNEE_NOT_FOUND', 'The assignee was not found.');
    }
    return c.body(null, 204);
  });

  routes.get('/:cardId/updates', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.card_updates.read', 'work.card_update', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const updates = await dependencies.store.listCardUpdates(organizationId, cardId);
    return c.json({ updates: updates.map(serializeUpdate) });
  });

  routes.get('/:cardId/submissions', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.submissions.read', 'work.submission', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const submissions = await dependencies.store.listSubmissionsByCard(organizationId, cardId);
    return c.json({ submissions: submissions.map(serializeSubmission) });
  });

  routes.post('/:cardId/submissions', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    await authorizeMutation(c, auth, 'work.submissions.create', 'work.submission', organizationId, cardId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const submission = await dependencies.store.createSubmission({
      organizationId,
      cardId,
      submittedBy: auth.actor.userId,
      submissionType: readOptionalString(
        body.submissionType ?? body.submission_type,
        'submissionType',
        FIELD_LIMITS.submissionType,
      ) ?? undefined,
      title: readRequiredText(body.title, 'title', FIELD_LIMITS.submissionTitle),
      notes: readOptionalString(body.notes, 'notes', FIELD_LIMITS.submissionNotes) ?? null,
      linkUrl:
        readOptionalString(body.linkUrl ?? body.link_url, 'linkUrl', FIELD_LIMITS.submissionUrl) ??
        null,
      fileName:
        readOptionalString(body.fileName ?? body.file_name, 'fileName', FIELD_LIMITS.filename) ??
        null,
      mimeType:
        readOptionalString(body.mimeType ?? body.mime_type, 'mimeType', FIELD_LIMITS.contentType) ??
        null,
      fileSize: readOptionalInteger(body.fileSize ?? body.file_size, 'fileSize'),
    });
    if (!submission) {
      throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
    }
    return c.json({ submission: serializeSubmission(submission) }, 201);
  });

  routes.get('/:cardId/submissions/:submissionId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    const submissionId = requireId(c.req.param('submissionId'), 'submissionId');
    authorize(auth, 'work.submissions.read', 'work.submission', organizationId, submissionId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const submission = await dependencies.store.getSubmissionById(organizationId, submissionId);
    if (!submission || submission.cardId !== cardId) {
      throw new NotFoundError('SUBMISSION_NOT_FOUND', 'The submission was not found.');
    }
    return c.json({ submission: serializeSubmission(submission) });
  });

  routes.get('/:cardId/attachments', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.attachments.read', 'work.attachment', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const attachments = await dependencies.store.listAttachmentsByCard(organizationId, cardId);
    return c.json({ attachments: attachments.map(serializeAttachment) });
  });

  routes.post('/:cardId/attachments', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    await authorizeMutation(c, auth, 'work.attachments.create', 'work.attachment', organizationId, cardId, 'attachment');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const filename = safeFilename(
      readRequiredText(body.filename ?? body.originalFilename, 'filename', FIELD_LIMITS.filename),
    );
    const contentType =
      readOptionalString(
        body.contentType ?? body.content_type,
        'contentType',
        FIELD_LIMITS.contentType,
      ) ?? 'application/octet-stream';
    const content = decodeStrictBase64(
      body.contentBase64 ?? body.content,
      'contentBase64',
      c.get('limits').maxAttachmentBytes,
    );
    const attachmentId = randomUUID();
    const objectKey = `${organizationId}/cards/${cardId}/attachments/${attachmentId}/${filename}`;
    await dependencies.files.putObject({
      bucket: env.minio.bucket,
      objectKey,
      body: content,
      contentType,
    });
    const attachment = await dependencies.store.createAttachment({
      id: attachmentId,
      organizationId,
      cardId,
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
      throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
    }
    return c.json({ attachment: serializeAttachment(attachment) }, 201);
  });

  routes.get('/:cardId/attachments/:attachmentId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    const attachmentId = requireId(c.req.param('attachmentId'), 'attachmentId');
    authorize(auth, 'work.attachments.read', 'work.attachment', organizationId, attachmentId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const attachment = await dependencies.store.getAttachmentById(organizationId, attachmentId);
    if (!attachment || attachment.cardId !== cardId) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    return c.json({ attachment: serializeAttachment(attachment) });
  });

  routes.get('/:cardId/time-entries', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.time_entries.read', 'work.time_entry', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const timeEntries = await dependencies.store.listTimeEntriesByCard(organizationId, cardId);
    return c.json({ timeEntries: timeEntries.map(serializeTimeEntry) });
  });

  routes.post('/:cardId/time-entries', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    await authorizeMutation(c, auth, 'work.time_entries.create', 'work.time_entry', organizationId, cardId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const requestedUserId = body.userId ?? body.user_id;
    const userId =
      requestedUserId === undefined
        ? auth.actor.userId
        : requireUuidValue(requestedUserId, 'userId');
    await requireOrganizationMember(dependencies.store, organizationId, userId);
    const seconds = readOptionalInteger(body.seconds, 'seconds');
    if (seconds === undefined || seconds < 0) {
      throw new ValidationError('seconds must be a non-negative integer.', {
        field: 'seconds',
      });
    }
    const entry = await dependencies.store.createTimeEntry({
      organizationId,
      cardId,
      userId,
      createdBy: auth.actor.userId,
      seconds,
      note: readOptionalString(body.note, 'note', FIELD_LIMITS.timeEntryNote) ?? null,
      startedAt: readOptionalTimestamp(body.startedAt ?? body.started_at, 'startedAt') ?? null,
      endedAt: readOptionalTimestamp(body.endedAt ?? body.ended_at, 'endedAt') ?? null,
      isBillable: readOptionalBoolean(body.isBillable ?? body.is_billable, 'isBillable'),
    });
    if (!entry) {
      throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
    }
    return c.json({ timeEntry: serializeTimeEntry(entry) }, 201);
  });

  routes.get('/:cardId/time-entries/:timeEntryId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    const timeEntryId = requireId(c.req.param('timeEntryId'), 'timeEntryId');
    authorize(auth, 'work.time_entries.read', 'work.time_entry', organizationId, timeEntryId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const entry = await dependencies.store.getTimeEntryById(organizationId, timeEntryId);
    if (!entry || entry.cardId !== cardId) {
      throw new NotFoundError('TIME_ENTRY_NOT_FOUND', 'The time entry was not found.');
    }
    return c.json({ timeEntry: serializeTimeEntry(entry) });
  });

  routes.get('/:cardId/checklists', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    authorize(auth, 'work.checklists.read', 'work.checklist', organizationId, cardId);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const checklists = await dependencies.store.listChecklistsByCard(organizationId, cardId);
    return c.json({ checklists: checklists.map(serializeChecklist) });
  });

  routes.post('/:cardId/checklists', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');
    await authorizeMutation(c, auth, 'work.checklists.create', 'work.checklist', organizationId, cardId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    await requireCardInOrganization(dependencies.store, organizationId, cardId);
    const checklist = await dependencies.store.createChecklist({
      organizationId,
      cardId,
      createdBy: auth.actor.userId,
      title: readRequiredText(body.title, 'title', FIELD_LIMITS.checklistTitle),
      position: readOptionalPosition(body.position),
    });
    if (!checklist) {
      throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
    }
    return c.json({ checklist: serializeChecklist(checklist) }, 201);
  });

  return routes;
}

export function createCommentRoutes(dependencies: CardEcosystemDependencies) {
  const routes = new Hono();

  routes.patch('/:commentId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const commentId = requireId(c.req.param('commentId'), 'commentId');
    await authorizeMutation(c, auth, 'work.card_comments.update', 'work.card_comment', organizationId, commentId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getCommentById(organizationId, commentId);
    if (!existing) {
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The comment was not found.');
    }
    assertCommentOwner(auth, existing.userId);
    const patch: UpdateCommentInput = {};
    if (body.body !== undefined) patch.body = readRequiredText(body.body, 'body', FIELD_LIMITS.commentBody);
    if (body.isInternal !== undefined || body.is_internal !== undefined) {
      patch.isInternal = readOptionalBoolean(
        body.isInternal ?? body.is_internal,
        'isInternal',
      );
    }
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No comment fields were provided to update.');
    }
    const comment = await dependencies.store.updateComment(organizationId, commentId, patch);
    if (!comment) {
      throw new NotFoundError('COMMENT_NOT_FOUND', 'The comment was not found.');
    }
    return c.json({ comment: serializeComment(comment) });
  });

  return routes;
}

export function createLabelRoutes(dependencies: CardEcosystemDependencies) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    authorize(auth, 'work.labels.read', 'work.label', organizationId);
    const labels = await dependencies.store.listLabels(organizationId);
    return c.json({ labels: labels.map(serializeLabel) });
  });

  routes.post('/', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    await authorizeMutation(c, auth, 'work.labels.create', 'work.label', organizationId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const label = await dependencies.store.createLabel({
      organizationId,
      name: readRequiredText(body.name, 'name', FIELD_LIMITS.labelName),
      color: readRequiredText(body.color, 'color', FIELD_LIMITS.labelColor),
    });
    return c.json({ label: serializeLabel(label) }, 201);
  });

  routes.patch('/:labelId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const labelId = requireId(c.req.param('labelId'), 'labelId');
    await authorizeMutation(c, auth, 'work.labels.update', 'work.label', organizationId, labelId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const patch: UpdateLabelInput = {};
    if (body.name !== undefined) patch.name = readRequiredText(body.name, 'name', FIELD_LIMITS.labelName);
    if (body.color !== undefined) patch.color = readRequiredText(body.color, 'color', FIELD_LIMITS.labelColor);
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No label fields were provided to update.');
    }
    const label = await dependencies.store.updateLabel(organizationId, labelId, patch);
    if (!label) {
      throw new NotFoundError('LABEL_NOT_FOUND', 'The label was not found.');
    }
    return c.json({ label: serializeLabel(label) });
  });

  return routes;
}

export function createSubmissionRoutes(dependencies: CardEcosystemDependencies) {
  const routes = new Hono();

  routes.get('/:submissionId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const submissionId = requireId(c.req.param('submissionId'), 'submissionId');
    authorize(auth, 'work.submissions.read', 'work.submission', organizationId, submissionId);
    const submission = await dependencies.store.getSubmissionById(organizationId, submissionId);
    if (!submission) {
      throw new NotFoundError('SUBMISSION_NOT_FOUND', 'The submission was not found.');
    }
    return c.json({ submission: serializeSubmission(submission) });
  });

  routes.patch('/:submissionId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const submissionId = requireId(c.req.param('submissionId'), 'submissionId');
    await authorizeMutation(c, auth, 'work.submissions.update', 'work.submission', organizationId, submissionId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getSubmissionById(organizationId, submissionId);
    if (!existing) {
      throw new NotFoundError('SUBMISSION_NOT_FOUND', 'The submission was not found.');
    }
    const patch: UpdateSubmissionInput = {};
    if (body.title !== undefined) {
      patch.title = readRequiredText(body.title, 'title', FIELD_LIMITS.submissionTitle);
    }
    if (body.notes !== undefined) {
      patch.notes = readOptionalString(body.notes, 'notes', FIELD_LIMITS.submissionNotes) ?? null;
    }
    if (body.linkUrl !== undefined || body.link_url !== undefined) {
      patch.linkUrl =
        readOptionalString(body.linkUrl ?? body.link_url, 'linkUrl', FIELD_LIMITS.submissionUrl) ??
        null;
    }
    if (body.approvalStatus !== undefined || body.approval_status !== undefined) {
      patch.approvalStatus = readRequiredText(
        body.approvalStatus ?? body.approval_status,
        'approvalStatus',
        32,
      );
      patch.reviewedBy = auth.actor.userId;
      patch.reviewedAt = new Date();
    }
    if (body.reviewNote !== undefined || body.review_note !== undefined) {
      patch.reviewNote =
        readOptionalString(body.reviewNote ?? body.review_note, 'reviewNote', FIELD_LIMITS.submissionNotes) ??
        null;
      patch.reviewedBy = auth.actor.userId;
      patch.reviewedAt = patch.reviewedAt ?? new Date();
    }
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No submission fields were provided to update.');
    }
    const submission = await dependencies.store.updateSubmission(
      organizationId,
      submissionId,
      patch,
    );
    if (!submission) {
      throw new NotFoundError('SUBMISSION_NOT_FOUND', 'The submission was not found.');
    }
    return c.json({ submission: serializeSubmission(submission) });
  });

  return routes;
}

export function createAttachmentRoutes(dependencies: CardEcosystemDependencies) {
  const routes = new Hono();

  routes.get('/:attachmentId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const attachmentId = requireId(c.req.param('attachmentId'), 'attachmentId');
    authorize(auth, 'work.attachments.read', 'work.attachment', organizationId, attachmentId);
    const attachment = await dependencies.store.getAttachmentById(organizationId, attachmentId);
    if (!attachment) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    return c.json({ attachment: serializeAttachment(attachment) });
  });

  routes.get('/:attachmentId/content', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const attachmentId = requireId(c.req.param('attachmentId'), 'attachmentId');
    authorize(auth, 'work.attachments.read', 'work.attachment', organizationId, attachmentId);
    const attachment = await dependencies.store.getAttachmentById(organizationId, attachmentId);
    if (!attachment) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    const stored = await dependencies.files.getObject(attachment.bucket, attachment.objectKey);
    if (!stored) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    return new Response(Uint8Array.from(stored.body), {
      status: 200,
      headers: {
        'content-type': stored.contentType ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${attachment.originalFilename}"`,
        'cache-control': 'private, no-store',
      },
    });
  });

  routes.delete('/:attachmentId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const attachmentId = requireId(c.req.param('attachmentId'), 'attachmentId');
    await authorizeMutation(c, auth, 'work.attachments.delete', 'work.attachment', organizationId, attachmentId);
    const attachment = await dependencies.store.deleteAttachment(organizationId, attachmentId);
    if (!attachment) {
      throw new NotFoundError('ATTACHMENT_NOT_FOUND', 'The attachment was not found.');
    }
    await dependencies.files.deleteObject(attachment.bucket, attachment.objectKey);
    return c.body(null, 204);
  });

  return routes;
}

export function createTimeEntryRoutes(dependencies: CardEcosystemDependencies) {
  const routes = new Hono();

  routes.get('/:timeEntryId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const timeEntryId = requireId(c.req.param('timeEntryId'), 'timeEntryId');
    authorize(auth, 'work.time_entries.read', 'work.time_entry', organizationId, timeEntryId);
    const entry = await dependencies.store.getTimeEntryById(organizationId, timeEntryId);
    if (!entry) {
      throw new NotFoundError('TIME_ENTRY_NOT_FOUND', 'The time entry was not found.');
    }
    return c.json({ timeEntry: serializeTimeEntry(entry) });
  });

  routes.patch('/:timeEntryId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const timeEntryId = requireId(c.req.param('timeEntryId'), 'timeEntryId');
    await authorizeMutation(c, auth, 'work.time_entries.update', 'work.time_entry', organizationId, timeEntryId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getTimeEntryById(organizationId, timeEntryId);
    if (!existing) {
      throw new NotFoundError('TIME_ENTRY_NOT_FOUND', 'The time entry was not found.');
    }
    const patch: UpdateTimeEntryInput = {};
    if (body.seconds !== undefined) {
      const seconds = readOptionalInteger(body.seconds, 'seconds');
      if (seconds === undefined || seconds < 0) {
        throw new ValidationError('seconds must be a non-negative integer.', {
          field: 'seconds',
        });
      }
      patch.seconds = seconds;
    }
    if (body.note !== undefined) {
      patch.note = readOptionalString(body.note, 'note', FIELD_LIMITS.timeEntryNote) ?? null;
    }
    if (body.startedAt !== undefined || body.started_at !== undefined) {
      patch.startedAt =
        readOptionalTimestamp(body.startedAt ?? body.started_at, 'startedAt') ?? null;
    }
    if (body.endedAt !== undefined || body.ended_at !== undefined) {
      patch.endedAt = readOptionalTimestamp(body.endedAt ?? body.ended_at, 'endedAt') ?? null;
    }
    if (body.isBillable !== undefined || body.is_billable !== undefined) {
      patch.isBillable = readOptionalBoolean(
        body.isBillable ?? body.is_billable,
        'isBillable',
      );
    }
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No time entry fields were provided to update.');
    }
    const entry = await dependencies.store.updateTimeEntry(organizationId, timeEntryId, patch);
    if (!entry) {
      throw new NotFoundError('TIME_ENTRY_NOT_FOUND', 'The time entry was not found.');
    }
    return c.json({ timeEntry: serializeTimeEntry(entry) });
  });

  return routes;
}

export function createChecklistRoutes(dependencies: CardEcosystemDependencies) {
  const routes = new Hono();

  routes.patch('/:checklistId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const checklistId = requireId(c.req.param('checklistId'), 'checklistId');
    await authorizeMutation(c, auth, 'work.checklists.update', 'work.checklist', organizationId, checklistId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getChecklistById(organizationId, checklistId);
    if (!existing) {
      throw new NotFoundError('CHECKLIST_NOT_FOUND', 'The checklist was not found.');
    }
    const patch: UpdateChecklistInput = {};
    if (body.title !== undefined) {
      patch.title = readRequiredText(body.title, 'title', FIELD_LIMITS.checklistTitle);
    }
    if (body.position !== undefined) {
      patch.position = readOptionalPosition(body.position);
    }
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No checklist fields were provided to update.');
    }
    const checklist = await dependencies.store.updateChecklist(organizationId, checklistId, patch);
    if (!checklist) {
      throw new NotFoundError('CHECKLIST_NOT_FOUND', 'The checklist was not found.');
    }
    return c.json({ checklist: serializeChecklist(checklist) });
  });

  routes.delete('/:checklistId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const checklistId = requireId(c.req.param('checklistId'), 'checklistId');
    await authorizeMutation(c, auth, 'work.checklists.delete', 'work.checklist', organizationId, checklistId);
    const existing = await dependencies.store.getChecklistById(organizationId, checklistId);
    if (!existing) {
      throw new NotFoundError('CHECKLIST_NOT_FOUND', 'The checklist was not found.');
    }
    const removed = await dependencies.store.deleteChecklist(organizationId, checklistId);
    if (!removed) {
      throw new NotFoundError('CHECKLIST_NOT_FOUND', 'The checklist was not found.');
    }
    return c.body(null, 204);
  });

  routes.post('/:checklistId/items', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const checklistId = requireId(c.req.param('checklistId'), 'checklistId');
    await authorizeMutation(c, auth, 'work.checklists.create', 'work.checklist', organizationId, checklistId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getChecklistById(organizationId, checklistId);
    if (!existing) {
      throw new NotFoundError('CHECKLIST_NOT_FOUND', 'The checklist was not found.');
    }
    const item = await dependencies.store.createChecklistItem({
      organizationId,
      checklistId,
      createdBy: auth.actor.userId,
      content: readRequiredText(body.content, 'content', FIELD_LIMITS.checklistItemContent),
      position: readOptionalPosition(body.position),
    });
    if (!item) {
      throw new NotFoundError('CHECKLIST_NOT_FOUND', 'The checklist was not found.');
    }
    return c.json({ item: serializeChecklistItem(item) }, 201);
  });

  return routes;
}

export function createChecklistItemRoutes(dependencies: CardEcosystemDependencies) {
  const routes = new Hono();

  routes.patch('/:itemId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const itemId = requireId(c.req.param('itemId'), 'itemId');
    await authorizeMutation(c, auth, 'work.checklists.update', 'work.checklist', organizationId, itemId);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const existing = await dependencies.store.getChecklistItemById(organizationId, itemId);
    if (!existing) {
      throw new NotFoundError('CHECKLIST_ITEM_NOT_FOUND', 'The checklist item was not found.');
    }
    const patch: UpdateChecklistItemInput = {};
    if (body.content !== undefined) {
      patch.content = readRequiredText(body.content, 'content', FIELD_LIMITS.checklistItemContent);
    }
    if (body.position !== undefined) {
      patch.position = readOptionalPosition(body.position);
    }
    if (body.isCompleted !== undefined || body.is_completed !== undefined) {
      patch.isCompleted = readOptionalBoolean(
        body.isCompleted ?? body.is_completed,
        'isCompleted',
      );
    }
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No checklist item fields were provided to update.');
    }
    const item = await dependencies.store.updateChecklistItem(
      organizationId,
      itemId,
      patch,
      auth.actor.userId,
    );
    if (!item) {
      throw new NotFoundError('CHECKLIST_ITEM_NOT_FOUND', 'The checklist item was not found.');
    }
    return c.json({ item: serializeChecklistItem(item) });
  });

  routes.delete('/:itemId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const itemId = requireId(c.req.param('itemId'), 'itemId');
    await authorizeMutation(c, auth, 'work.checklists.delete', 'work.checklist', organizationId, itemId);
    const existing = await dependencies.store.getChecklistItemById(organizationId, itemId);
    if (!existing) {
      throw new NotFoundError('CHECKLIST_ITEM_NOT_FOUND', 'The checklist item was not found.');
    }
    const removed = await dependencies.store.deleteChecklistItem(organizationId, itemId);
    if (!removed) {
      throw new NotFoundError('CHECKLIST_ITEM_NOT_FOUND', 'The checklist item was not found.');
    }
    return c.body(null, 204);
  });

  return routes;
}