import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { isUuid } from '../auth/uuid.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';
import type { AuthContext } from '../authorization/types.js';
import { env } from '../config/env.js';
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../http/errors.js';
import { listOffset } from '../db/list-bounds.js';
import { readListQuery } from '../http/list-query.js';
import { FIELD_LIMITS } from '../http/limits.js';
import { rateLimitWork } from '../http/work-rate-limit.js';
import { sendAttendanceEmail } from '../email/attendance-mailer.js';
import { attachmentDisposition, streamStoredMedia } from '../content/media-stream.js';
import type { FileStorage } from '../files/storage.js';
import type { NotificationStore } from '../notifications/store.js';
import type {
  EmployeeDocumentRecipientRecord,
  PayslipBatchItemRecord,
  PayslipBatchRecord,
  PostgresDocumentsStore,
} from '../documents/postgres-store.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';

export const EMPLOYEE_DOCUMENTS_BUCKET = 'employee-documents';
const MAX_DOCUMENT_UPLOAD_BYTES = env.limits.maxAttachmentBytes;
const ALLOWED_DOCUMENT_TYPES = new Set([
  'payslip',
  'warning',
  'letter',
  'contract',
  'policy',
  'announcement',
  'leave',
  'asset',
  'performance',
  'notice',
]);

export type DocumentsRouteDependencies = {
  store: PostgresDocumentsStore;
  files: FileStorage;
  notifications: NotificationStore;
};

function authorizeDocuments(auth: ReturnType<typeof getAuth>, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: { type: 'document', organizationId },
  });
  return organizationId;
}

function isDocumentsStaff(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it' ||
    hasPermission(auth.membership.permissions, 'documents.manage')
  );
}

function requireDocumentsStaff(auth: AuthContext) {
  if (!isDocumentsStaff(auth)) {
    throw new ForbiddenError(
      'DOCUMENTS_ADMIN_REQUIRED',
      'Only admin, manager, or IT users can manage employee documents and payslips.',
    );
  }
}

function serializeRecipient(
  row: EmployeeDocumentRecipientRecord & {
    userName?: string | null;
    userEmail?: string | null;
  },
) {
  return {
    id: row.id,
    organization_id: row.organizationId,
    document_id: row.documentId,
    user_id: row.userId,
    status: row.status,
    delivered_at: row.deliveredAt.toISOString(),
    read_at: row.readAt?.toISOString() ?? null,
    acknowledged_at: row.acknowledgedAt?.toISOString() ?? null,
    archived_at: row.archivedAt?.toISOString() ?? null,
    acknowledgement_note: row.acknowledgementNote,
    created_at: row.createdAt.toISOString(),
    user_name: row.userName ?? null,
    user_email: row.userEmail ?? null,
    document: {
      id: row.document.id,
      organization_id: row.document.organizationId,
      title: row.document.title,
      message: row.document.message,
      document_type: row.document.documentType,
      file_bucket: row.document.fileBucket,
      file_path: row.document.filePath,
      file_name: row.document.fileName,
      mime_type: row.document.mimeType,
      size_bytes: row.document.sizeBytes,
      requires_acknowledgement: row.document.requiresAcknowledgement,
      is_confidential: row.document.isConfidential,
      created_by: row.document.createdBy,
      created_at: row.document.createdAt.toISOString(),
      updated_at: row.document.updatedAt.toISOString(),
      expires_at: row.document.expiresAt?.toISOString() ?? null,
      metadata: row.document.metadata,
    },
  };
}

function serializeBatch(row: PayslipBatchRecord) {
  return {
    id: row.id,
    organization_id: row.organizationId,
    title: row.title,
    payroll_month: row.payrollMonth,
    payroll_year: row.payrollYear,
    status: row.status,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
    metadata: row.metadata,
  };
}

function serializeBatchItem(row: PayslipBatchItemRecord) {
  return {
    id: row.id,
    organization_id: row.organizationId,
    batch_id: row.batchId,
    user_id: row.userId,
    employee_email: row.employeeEmail,
    employee_name: row.employeeName,
    document_id: row.documentId,
    file_name: row.fileName,
    file_path: row.filePath,
    match_status: row.matchStatus,
    error_message: row.errorMessage,
    created_at: row.createdAt.toISOString(),
  };
}

function normalizeIdentity(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^\w.\-()[\] ]+/g, '_').slice(0, 180);
}

function assertSafeObjectKey(objectKey: string, organizationId: string) {
  if (
    !objectKey ||
    objectKey.includes('..') ||
    objectKey.startsWith('/') ||
    !objectKey.startsWith(`${organizationId}/`)
  ) {
    throw new ValidationError('Invalid storage path for this organization.', {
      field: 'filePath',
    });
  }
}

function payslipPathBelongsToUser(filePath: string, userId: string) {
  return `/${filePath}/`.includes(`/${userId}/`);
}

function makePayslipPath(params: {
  organizationId: string;
  payrollYear: number;
  payrollMonth: number;
  userId: string;
  fileName: string;
}) {
  const month = String(params.payrollMonth).padStart(2, '0');
  return `${params.organizationId}/payslips/${params.payrollYear}-${month}/${params.userId}/${sanitizeFileName(params.fileName)}`;
}

function makeDocumentPath(params: {
  organizationId: string;
  documentId: string;
  fileName: string;
}) {
  return `${params.organizationId}/${params.documentId}/${sanitizeFileName(params.fileName)}`;
}

function requireBinaryUploadSize(c: { req: { header: (name: string) => string | undefined } }) {
  const raw = c.req.header('content-length');
  if (!raw) {
    throw new ValidationError('Content-Length is required for binary uploads.', {
      field: 'Content-Length',
    });
  }
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 1) {
    throw new ValidationError('Content-Length must be a positive number.', {
      field: 'Content-Length',
    });
  }
  if (size > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new PayloadTooLargeError();
  }
  return size;
}

async function putBinary(
  files: FileStorage,
  input: {
    objectKey: string;
    body: ReadableStream<Uint8Array>;
    contentType: string;
    contentLength: number;
  },
) {
  await files.ensureBucket?.(EMPLOYEE_DOCUMENTS_BUCKET);
  const put =
    files.putObjectStream?.bind(files) ??
    (async (streamInput: {
      bucket: string;
      objectKey: string;
      body: ReadableStream<Uint8Array> | Buffer;
      contentType?: string | null;
      contentLength: number;
    }) => {
      const chunks: Uint8Array[] = [];
      if (Buffer.isBuffer(streamInput.body)) {
        chunks.push(streamInput.body);
      } else {
        const reader = streamInput.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
      }
      await files.putObject({
        bucket: streamInput.bucket,
        objectKey: streamInput.objectKey,
        body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        contentType: streamInput.contentType,
      });
    });

  await put({
    bucket: EMPLOYEE_DOCUMENTS_BUCKET,
    objectKey: input.objectKey,
    body: input.body,
    contentType: input.contentType,
    contentLength: input.contentLength,
  });
}

async function moveObject(
  files: FileStorage,
  fromKey: string,
  toKey: string,
) {
  if (fromKey === toKey) return;
  if (files.headObject) {
    const head = await files.headObject(EMPLOYEE_DOCUMENTS_BUCKET, fromKey);
    if (!head) {
      throw new NotFoundError(
        'DOCUMENT_FILE_NOT_FOUND',
        'Payslip PDF is missing in storage.',
      );
    }
    if (head.sizeBytes != null && head.sizeBytes > env.limits.maxAttachmentBytes) {
      throw new PayloadTooLargeError(
        'Payslip PDF exceeds the attachment size limit.',
      );
    }
  }
  const object = await files.getObject(EMPLOYEE_DOCUMENTS_BUCKET, fromKey);
  if (!object) {
    throw new NotFoundError(
      'DOCUMENT_FILE_NOT_FOUND',
      'Payslip PDF is missing in storage.',
    );
  }
  await files.ensureBucket?.(EMPLOYEE_DOCUMENTS_BUCKET);
  await files.putObject({
    bucket: EMPLOYEE_DOCUMENTS_BUCKET,
    objectKey: toKey,
    body: object.body,
    contentType: object.contentType,
  });
  await files.deleteObject(EMPLOYEE_DOCUMENTS_BUCKET, fromKey);
}

async function notifyDocumentRecipients(params: {
  notifications: NotificationStore;
  organizationId: string;
  actorUserId: string;
  documentId: string;
  documentType: string;
  title: string;
  message: string;
  requiresAcknowledgement: boolean;
  recipients: Array<{ userId: string; email: string | null; fullName: string | null }>;
}) {
  const actionUrl = `/inbox?documentId=${params.documentId}`;
  const notificationTitle =
    params.documentType === 'payslip'
      ? 'New payslip available'
      : params.requiresAcknowledgement
        ? 'New HR document requires acknowledgement'
        : 'New document available';
  const notificationMessage =
    params.documentType === 'payslip'
      ? `${params.title} is available in your inbox.`
      : params.requiresAcknowledgement
        ? 'Please review and acknowledge this document.'
        : `${params.title} is available in your inbox.`;
  const priority =
    params.requiresAcknowledgement || params.documentType === 'warning'
      ? 'high'
      : 'medium';

  for (const recipient of params.recipients) {
    await params.notifications.create({
      organizationId: params.organizationId,
      recipientUserId: recipient.userId,
      actorUserId: params.actorUserId,
      type: 'announcement',
      title: notificationTitle,
      message: notificationMessage,
      entityType: 'employee_document',
      entityId: params.documentId,
      actionUrl,
      priority,
      category: 'hr',
      dedupeKey: `employee_document:${params.documentId}:${recipient.userId}`,
      metadata: {
        document_type: params.documentType,
        requires_acknowledgement: params.requiresAcknowledgement,
      },
    });

    if (recipient.email) {
      await sendAttendanceEmail({
        to: recipient.email,
        subject: notificationTitle,
        text: [
          `Hi ${recipient.fullName ?? 'there'},`,
          '',
          notificationMessage,
          '',
          `Open in workspace: ${actionUrl}`,
        ].join('\n'),
      });
    }
  }
}

async function collectPayslipBatchItems(
  store: PostgresDocumentsStore,
  organizationId: string,
  batchId: string,
) {
  const items: PayslipBatchItemRecord[] = [];
  let before: string | undefined;
  let beforeId: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await store.listPayslipBatchItems(organizationId, batchId, {
      limit: 200,
      before,
      beforeId,
    });
    items.push(...result.items);
    if (!result.hasMore || result.items.length === 0) return items;
    const last = result.items[result.items.length - 1];
    if (!last) return items;
    before =
      last.createdAt instanceof Date
        ? last.createdAt.toISOString()
        : String(last.createdAt);
    beforeId = last.id;
  }
  throw new ValidationError(
    'Payslip batch is larger than the delivery page limit. Deliver a smaller selection.',
  );
}

export function createDocumentsRoutes(dependencies: DocumentsRouteDependencies) {
  const routes = new Hono();

  routes.get('/inbox', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.read');
    const status = c.req.query('status') ?? undefined;
    const documentType = c.req.query('documentType') ?? undefined;
    const page = readListQuery(c);
    const rows = await dependencies.store.listMine({
      organizationId,
      userId: auth.actor.userId,
      status,
      documentType,
      limit: page.limit,
      before: page.before,
      beforeId: page.beforeId,
    });
    return c.json({
      documents: rows.documents.map(serializeRecipient),
      hasMore: rows.hasMore,
    });
  });

  routes.get('/inbox/unread-count', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.read');
    const count = await dependencies.store.countUnread(
      organizationId,
      auth.actor.userId,
    );
    return c.json({ count });
  });

  routes.get('/inbox/:recipientId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.read');
    const recipientId = requireUuidValue(c.req.param('recipientId'), 'recipientId');
    const row = await dependencies.store.getMine(
      organizationId,
      auth.actor.userId,
      recipientId,
    );
    if (!row) {
      throw new NotFoundError(
        'DOCUMENT_RECIPIENT_NOT_FOUND',
        'Document was not found.',
      );
    }
    return c.json({ document: serializeRecipient(row) });
  });

  routes.post('/inbox/:recipientId/read', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.read');
    await rateLimitWork(c, 'mutation');
    const recipientId = requireUuidValue(c.req.param('recipientId'), 'recipientId');
    const row = await dependencies.store.markRead(
      organizationId,
      auth.actor.userId,
      recipientId,
    );
    return c.json({ document: serializeRecipient(row!) });
  });

  routes.post('/inbox/:recipientId/acknowledge', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.read');
    await rateLimitWork(c, 'mutation');
    const recipientId = requireUuidValue(c.req.param('recipientId'), 'recipientId');
    const body = await readJson(c).catch(() => ({}));
    const note = readOptionalString(
      (body as { note?: string }).note,
      'note',
      2000,
    );
    const row = await dependencies.store.acknowledge(
      organizationId,
      auth.actor.userId,
      recipientId,
      note,
    );
    return c.json({ document: serializeRecipient(row!) });
  });

  routes.get('/inbox/:recipientId/file', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.read');
    const recipientId = requireUuidValue(c.req.param('recipientId'), 'recipientId');
    const row = await dependencies.store.getMine(
      organizationId,
      auth.actor.userId,
      recipientId,
    );
    if (!row?.document.filePath) {
      throw new NotFoundError(
        'DOCUMENT_FILE_NOT_FOUND',
        'Document file was not found.',
      );
    }
    assertSafeObjectKey(row.document.filePath, organizationId);
    const response = await streamStoredMedia({
      files: dependencies.files,
      bucket: row.document.fileBucket || EMPLOYEE_DOCUMENTS_BUCKET,
      objectKey: row.document.filePath,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, max-age=60',
      contentType: row.document.mimeType,
      contentDisposition: attachmentDisposition(
        'inline',
        row.document.fileName ?? 'document',
      ),
      notFoundCode: 'DOCUMENT_FILE_NOT_FOUND',
      notFoundMessage: 'Document file was not found.',
    });
    await dependencies.store.audit({
      organizationId,
      documentId: row.documentId,
      recipientId: row.id,
      actorUserId: auth.actor.userId,
      action: 'document_file_opened',
    });
    return response;
  });

  routes.get('/employees', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    const officeId = c.req.query('officeId');
    if (officeId && !isUuid(officeId)) {
      throw new ValidationError('officeId must be a UUID.', { field: 'officeId' });
    }
    const page = readListQuery(c);
    const members = await dependencies.store.listActiveOrgMembers(organizationId, {
      officeId: officeId ?? null,
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    });
    return c.json({ employees: members.members, hasMore: members.hasMore });
  });

  routes.get('/admin/deliveries', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    const rows = await dependencies.store.listAdminDeliveries(
      organizationId,
      readListQuery(c),
    );
    return c.json({
      deliveries: rows.deliveries.map(serializeRecipient),
      hasMore: rows.hasMore,
    });
  });

  routes.post('/send', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    await rateLimitWork(c, 'mutation');
    const body = await readJson(c);

    const documentId =
      typeof body.documentId === 'string' && isUuid(body.documentId)
        ? body.documentId
        : randomUUID();
    const title = readRequiredText(body.title, 'title', 300);
    const documentType = readRequiredText(body.documentType, 'documentType', 40);
    if (!ALLOWED_DOCUMENT_TYPES.has(documentType)) {
      throw new ValidationError('Unsupported document type.', {
        field: 'documentType',
      });
    }
    const recipientUserIds = Array.isArray(body.recipientUserIds)
      ? [...new Set(body.recipientUserIds.filter((id): id is string => typeof id === 'string' && isUuid(id)))]
      : [];
    if (recipientUserIds.length === 0) {
      throw new ValidationError('At least one recipient is required.', {
        field: 'recipientUserIds',
      });
    }
    if (recipientUserIds.length > 200) {
      throw new ValidationError('Too many recipients in one send.', {
        field: 'recipientUserIds',
      });
    }

    const members = await dependencies.store.listActiveMembersByIds(
      organizationId,
      recipientUserIds,
    );
    const byId = new Map(members.map((member) => [member.id, member]));
    const activeRecipients = recipientUserIds.map((userId) => {
      const member = byId.get(userId);
      if (!member) {
        throw new ValidationError(
          'Refuse to send: one or more selected recipients are missing, inactive, or outside this organization.',
          { field: 'recipientUserIds' },
        );
      }
      return member;
    });

    const filePath =
      typeof body.filePath === 'string' ? body.filePath : null;
    const isConfidential = body.isConfidential !== false;
    if (filePath) {
      assertSafeObjectKey(filePath, organizationId);
      if (isConfidential && activeRecipients.length === 1) {
        const soleUserId = activeRecipients[0]!.id;
        if (
          `/${filePath}/`.includes('/payslips/') &&
          !payslipPathBelongsToUser(filePath, soleUserId)
        ) {
          throw new ValidationError(
            'Refuse to send: file is not in this employee’s folder. Rematch them so the file is stored under their folder first.',
            { field: 'filePath' },
          );
        }
      }
      const existing = dependencies.files.headObject
        ? await dependencies.files.headObject(EMPLOYEE_DOCUMENTS_BUCKET, filePath)
        : await dependencies.files.getObject(EMPLOYEE_DOCUMENTS_BUCKET, filePath);
      if (!existing) {
        throw new ValidationError(
          'Refuse to send: attached file is missing in storage.',
          { field: 'filePath' },
        );
      }
    }

    const document = await dependencies.store.createDocument({
      id: documentId,
      organizationId,
      title,
      message:
        typeof body.message === 'string' ? body.message.trim() || null : null,
      documentType,
      filePath,
      fileName: typeof body.fileName === 'string' ? body.fileName : null,
      mimeType: typeof body.mimeType === 'string' ? body.mimeType : null,
      sizeBytes:
        typeof body.sizeBytes === 'number' ? body.sizeBytes : null,
      requiresAcknowledgement: Boolean(body.requiresAcknowledgement),
      isConfidential,
      createdBy: auth.actor.userId,
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : {},
    });

    const createdRecipients = await dependencies.store.createRecipients({
      organizationId,
      documentId: document.id,
      userIds: activeRecipients.map((row) => row.id),
    });

    await dependencies.store.audit({
      organizationId,
      documentId: document.id,
      actorUserId: auth.actor.userId,
      action: 'document_created',
      metadata: { recipient_count: createdRecipients.length },
    });
    for (const recipient of createdRecipients) {
      await dependencies.store.audit({
        organizationId,
        documentId: document.id,
        recipientId: recipient.id,
        actorUserId: auth.actor.userId,
        action: 'document_sent',
        metadata: { user_id: recipient.userId },
      });
    }

    await notifyDocumentRecipients({
      notifications: dependencies.notifications,
      organizationId,
      actorUserId: auth.actor.userId,
      documentId: document.id,
      documentType,
      title,
      message:
        typeof body.message === 'string' ? body.message : title,
      requiresAcknowledgement: Boolean(body.requiresAcknowledgement),
      recipients: activeRecipients.map((row) => ({
        userId: row.id,
        email: row.email,
        fullName: row.full_name,
      })),
    });

    return c.json(
      { ok: true, documentId: document.id, delivered: createdRecipients.length },
      201,
    );
  });

  routes.post('/unsend/:recipientId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    await rateLimitWork(c, 'mutation');
    const recipientId = requireUuidValue(c.req.param('recipientId'), 'recipientId');
    const recipient = await dependencies.store.getRecipientById(
      organizationId,
      recipientId,
    );
    if (!recipient) {
      throw new NotFoundError('DOCUMENT_RECIPIENT_NOT_FOUND', 'Delivery was not found.');
    }

    await dependencies.store.audit({
      organizationId,
      documentId: recipient.document_id as string,
      recipientId,
      actorUserId: auth.actor.userId,
      action: 'document_unsent',
      metadata: {
        user_id: recipient.user_id,
        previous_status: recipient.status,
      },
    });
    await dependencies.store.deleteRecipient(organizationId, recipientId);
    return c.json({
      ok: true,
      recipientId,
      notificationsRemoved: 0,
      pendingEmailsCancelled: 0,
    });
  });

  routes.post('/upload/binary', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    await rateLimitWork(c, 'attachment');

    const sizeBytes = requireBinaryUploadSize(c);
    const filename = sanitizeFileName(
      decodeURIComponent(
        c.req.query('filename') ?? c.req.header('x-kode-filename') ?? 'document.bin',
      ),
    );
    const contentType =
      readOptionalString(
        c.req.header('content-type') ?? c.req.header('x-kode-content-type'),
        'contentType',
        FIELD_LIMITS.contentType,
      ) ?? 'application/octet-stream';
    const documentId =
      c.req.query('documentId') && isUuid(c.req.query('documentId')!)
        ? c.req.query('documentId')!
        : randomUUID();
    if (!c.req.raw.body) {
      throw new ValidationError('Request body is required.', { field: 'body' });
    }

    const objectKey = makeDocumentPath({
      organizationId,
      documentId,
      fileName: filename,
    });
    await putBinary(dependencies.files, {
      objectKey,
      body: c.req.raw.body,
      contentType,
      contentLength: sizeBytes,
    });

    return c.json({
      ok: true,
      documentId,
      filePath: objectKey,
      fileName: filename,
      mimeType: contentType,
      sizeBytes,
    });
  });

  routes.get('/payslip-batches', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    const batches = await dependencies.store.listPayslipBatches(
      organizationId,
      readListQuery(c),
    );
    return c.json({
      batches: batches.batches.map(serializeBatch),
      hasMore: batches.hasMore,
    });
  });

  routes.post('/payslip-batches', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    await rateLimitWork(c, 'mutation');
    const body = await readJson(c);
    const title = readRequiredText(body.title, 'title', 300);
    const payrollMonth = Number(body.payrollMonth ?? body.payroll_month);
    const payrollYear = Number(body.payrollYear ?? body.payroll_year);
    if (!Number.isInteger(payrollMonth) || payrollMonth < 1 || payrollMonth > 12) {
      throw new ValidationError('payrollMonth must be 1-12.', {
        field: 'payrollMonth',
      });
    }
    if (!Number.isInteger(payrollYear) || payrollYear < 2000 || payrollYear > 2100) {
      throw new ValidationError('payrollYear is invalid.', {
        field: 'payrollYear',
      });
    }
    const batch = await dependencies.store.createPayslipBatch({
      organizationId,
      title,
      payrollMonth,
      payrollYear,
      createdBy: auth.actor.userId,
    });
    return c.json({ batch: serializeBatch(batch) }, 201);
  });

  routes.get('/payslip-batches/:batchId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    const batchId = requireUuidValue(c.req.param('batchId'), 'batchId');
    const batch = await dependencies.store.getPayslipBatch(organizationId, batchId);
    if (!batch) {
      throw new NotFoundError('PAYSLIP_BATCH_NOT_FOUND', 'Payslip batch was not found.');
    }
    const items = await dependencies.store.listPayslipBatchItems(
      organizationId,
      batchId,
      readListQuery(c),
    );
    return c.json({
      batch: serializeBatch(batch),
      items: items.items.map(serializeBatchItem),
      hasMore: items.hasMore,
    });
  });

  routes.delete('/payslip-batches/:batchId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    await rateLimitWork(c, 'mutation');
    const batchId = requireUuidValue(c.req.param('batchId'), 'batchId');
    const deleted = await dependencies.store.deletePayslipBatch(
      organizationId,
      batchId,
    );
    if (!deleted) {
      throw new NotFoundError('PAYSLIP_BATCH_NOT_FOUND', 'Payslip batch was not found.');
    }
    return c.json({ ok: true });
  });

  routes.post('/payslip-batches/:batchId/items/binary', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    await rateLimitWork(c, 'attachment');

    const batchId = requireUuidValue(c.req.param('batchId'), 'batchId');
    const batch = await dependencies.store.getPayslipBatch(organizationId, batchId);
    if (!batch) {
      throw new NotFoundError('PAYSLIP_BATCH_NOT_FOUND', 'Payslip batch was not found.');
    }

    const sizeBytes = requireBinaryUploadSize(c);
    const filename = sanitizeFileName(
      decodeURIComponent(
        c.req.query('filename') ?? c.req.header('x-kode-filename') ?? 'payslip.pdf',
      ),
    );
    const contentType =
      readOptionalString(
        c.req.header('content-type') ?? c.req.header('x-kode-content-type'),
        'contentType',
        FIELD_LIMITS.contentType,
      ) ?? 'application/pdf';
    if (!contentType.includes('pdf') && !filename.toLowerCase().endsWith('.pdf')) {
      throw new ValidationError('Payslip uploads must be PDF files.', {
        field: 'contentType',
      });
    }

    const userIdRaw = c.req.query('userId') ?? c.req.header('x-kode-user-id');
    const userId =
      typeof userIdRaw === 'string' && isUuid(userIdRaw) ? userIdRaw : null;
    let employeeEmail: string | null = null;
    let employeeName: string | null = null;
    let matchStatus = 'unmatched';
    let errorMessage:
      | string
      | null = 'Can’t match this user. Choose the correct employee by name from the list.';

    if (userId) {
      const member = await dependencies.store.getActiveOrgMember(
        organizationId,
        userId,
      );
      if (!member) {
        throw new ValidationError(
          'Refuse to upload: matched employee is missing, inactive, or outside this organization.',
          { field: 'userId' },
        );
      }
      employeeEmail = member.email;
      employeeName = member.full_name || member.email || 'Unnamed employee';
      matchStatus = 'matched';
      errorMessage = null;
    }

    const objectKey = makePayslipPath({
      organizationId,
      payrollYear: batch.payrollYear,
      payrollMonth: batch.payrollMonth,
      userId: userId ?? `unmatched-${randomUUID()}`,
      fileName: filename,
    });
    if (!c.req.raw.body) {
      throw new ValidationError('Request body is required.', { field: 'body' });
    }
    await putBinary(dependencies.files, {
      objectKey,
      body: c.req.raw.body,
      contentType,
      contentLength: sizeBytes,
    });

    const item = await dependencies.store.createPayslipBatchItem({
      organizationId,
      batchId,
      userId,
      employeeEmail,
      employeeName,
      fileName: filename,
      filePath: objectKey,
      mimeType: contentType,
      sizeBytes,
      matchStatus,
      errorMessage,
    });

    return c.json({ item: serializeBatchItem(item) }, 201);
  });

  routes.patch('/payslip-batches/:batchId/items/:itemId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    await rateLimitWork(c, 'mutation');
    const batchId = requireUuidValue(c.req.param('batchId'), 'batchId');
    const itemId = requireUuidValue(c.req.param('itemId'), 'itemId');
    const batch = await dependencies.store.getPayslipBatch(organizationId, batchId);
    if (!batch) {
      throw new NotFoundError('PAYSLIP_BATCH_NOT_FOUND', 'Payslip batch was not found.');
    }
    const existing = await dependencies.store.getPayslipBatchItem(
      organizationId,
      itemId,
    );
    if (!existing || existing.batchId !== batchId) {
      throw new NotFoundError('PAYSLIP_ITEM_NOT_FOUND', 'Payslip batch item was not found.');
    }
    if (existing.documentId || existing.matchStatus === 'delivered') {
      throw new ValidationError(
        'Already delivered payslips cannot be reassigned. The delivered document stays in the employee inbox.',
      );
    }

    const body = await readJson(c);
    const employeeId =
      body.employeeId === null
        ? null
        : typeof body.employeeId === 'string' && isUuid(body.employeeId)
          ? body.employeeId
          : typeof body.userId === 'string' && isUuid(body.userId)
            ? body.userId
            : undefined;

    if (employeeId === undefined) {
      throw new ValidationError('employeeId is required.', { field: 'employeeId' });
    }

    if (employeeId === null) {
      const item = await dependencies.store.updatePayslipBatchItem(
        organizationId,
        itemId,
        {
          userId: null,
          clearUser: true,
          employeeEmail: null,
          employeeName: null,
          matchStatus: 'unmatched',
          errorMessage:
            'Can’t match this user. Choose the correct employee by name from the list.',
        },
      );
      return c.json({ item: serializeBatchItem(item) });
    }

    const member = await dependencies.store.getActiveOrgMember(
      organizationId,
      employeeId,
    );
    if (!member) {
      throw new ValidationError(
        'Refuse to save match: employee is missing, inactive, or outside this organization.',
        { field: 'employeeId' },
      );
    }

    const targetPath = makePayslipPath({
      organizationId,
      payrollYear: batch.payrollYear,
      payrollMonth: batch.payrollMonth,
      userId: employeeId,
      fileName: existing.fileName,
    });
    if (existing.filePath && existing.filePath !== targetPath) {
      assertSafeObjectKey(existing.filePath, organizationId);
      await moveObject(dependencies.files, existing.filePath, targetPath);
    }
    if (!payslipPathBelongsToUser(targetPath, employeeId)) {
      throw new ValidationError(
        'Refuse to save match — file is not in this employee’s folder.',
      );
    }

    const item = await dependencies.store.updatePayslipBatchItem(
      organizationId,
      itemId,
      {
        userId: employeeId,
        employeeEmail: member.email,
        employeeName: member.full_name || member.email || 'Unnamed employee',
        filePath: targetPath,
        matchStatus: 'matched',
        errorMessage: null,
      },
    );
    return c.json({ item: serializeBatchItem(item) });
  });

  routes.post('/payslip-batches/:batchId/deliver', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeDocuments(auth, 'documents.manage');
    requireDocumentsStaff(auth);
    await rateLimitWork(c, 'mutation');

    const batchId = requireUuidValue(c.req.param('batchId'), 'batchId');
    const batch = await dependencies.store.getPayslipBatch(organizationId, batchId);
    if (!batch) {
      throw new NotFoundError('PAYSLIP_BATCH_NOT_FOUND', 'Payslip batch was not found.');
    }

    const body = await readJson(c).catch(() => ({}));
    const selectedItemIds = Array.isArray((body as { itemIds?: unknown }).itemIds)
      ? [
          ...new Set(
            ((body as { itemIds: unknown[] }).itemIds).filter(
              (id): id is string => typeof id === 'string' && isUuid(id),
            ),
          ),
        ]
      : [];

    const allItems = await collectPayslipBatchItems(
      dependencies.store,
      organizationId,
      batchId,
    );
    const candidates = allItems.filter((item) => {
      if (selectedItemIds.length > 0 && !selectedItemIds.includes(item.id)) {
        return false;
      }
      return item.matchStatus === 'matched' && !item.documentId;
    });
    if (candidates.length === 0) {
      throw new ValidationError(
        'No matched payslips are ready. Every file must be matched to an employee folder before delivery.',
      );
    }

    await dependencies.store.updatePayslipBatchStatus(
      organizationId,
      batchId,
      'processing',
    );

    let delivered = 0;
    let failed = 0;

    for (const item of candidates) {
      let createdDocumentId: string | null = null;
      try {
        if (!item.userId || !item.filePath) {
          throw new Error(
            'Refuse to send: can’t match this user to an employee folder. Choose the correct person before delivery.',
          );
        }
        if (!item.employeeEmail || !item.employeeName) {
          throw new Error(
            'Refuse to send: payslip must be matched to a named employee with a registered email before delivery.',
          );
        }
        assertSafeObjectKey(item.filePath, organizationId);
        if (!payslipPathBelongsToUser(item.filePath, item.userId)) {
          throw new Error(
            'Refuse to send: file is not in this employee’s folder. Rematch them so the PDF moves into their folder first.',
          );
        }

        const member = await dependencies.store.getActiveOrgMember(
          organizationId,
          item.userId,
        );
        if (!member) {
          throw new Error(
            'Refuse to send: can’t match this user. Choose the correct employee from the list.',
          );
        }

        const storedEmail = normalizeIdentity(item.employeeEmail);
        const storedName = normalizeIdentity(item.employeeName);
        const registeredEmail = normalizeIdentity(member.email);
        const registeredName = normalizeIdentity(member.full_name);
        if (!storedEmail || !registeredEmail || storedEmail !== registeredEmail) {
          throw new Error(
            'Refuse to send: matched email does not match the registered employee email. Correct the match before delivery.',
          );
        }
        const expectedName = registeredName || registeredEmail;
        if (!storedName || !expectedName || storedName !== expectedName) {
          throw new Error(
            'Refuse to send: matched name does not match the registered employee name. Correct the match before delivery.',
          );
        }

        if (dependencies.files.headObject) {
          const head = await dependencies.files.headObject(
            EMPLOYEE_DOCUMENTS_BUCKET,
            item.filePath,
          );
          if (head?.sizeBytes != null && head.sizeBytes > env.limits.maxAttachmentBytes) {
            throw new Error(
              'Refuse to send: payslip PDF exceeds the attachment size limit.',
            );
          }
        }
        const object = await dependencies.files.getObject(
          EMPLOYEE_DOCUMENTS_BUCKET,
          item.filePath,
        );
        if (!object) {
          throw new Error(
            'Refuse to send: payslip PDF is missing in storage. Re-upload before delivery so the employee does not lose their file.',
          );
        }

        const title = `${batch.title} - Payslip`;
        const document = await dependencies.store.createDocument({
          organizationId,
          title,
          message: `Your ${batch.title} is available in your inbox.`,
          documentType: 'payslip',
          filePath: item.filePath,
          fileName: item.fileName,
          mimeType: 'application/pdf',
          sizeBytes: item.sizeBytes ?? object.sizeBytes,
          requiresAcknowledgement: false,
          isConfidential: true,
          createdBy: auth.actor.userId,
          metadata: {
            payslip_batch_id: batch.id,
            payroll_month: batch.payrollMonth,
            payroll_year: batch.payrollYear,
            recipient_user_id: item.userId,
            recipient_email: member.email,
            recipient_name: member.full_name,
          },
        });
        createdDocumentId = document.id;

        const recipients = await dependencies.store.createRecipients({
          organizationId,
          documentId: document.id,
          userIds: [item.userId],
        });
        if (recipients.length !== 1) {
          throw new Error(
            'Confidential payslip must have exactly one recipient. Delivery aborted.',
          );
        }
        const recipientCount = await dependencies.store.countRecipientsForDocument(
          document.id,
        );
        if (recipientCount !== 1) {
          throw new Error(
            'Confidential payslip must have exactly one recipient. Delivery aborted.',
          );
        }

        await dependencies.store.audit({
          organizationId,
          documentId: document.id,
          actorUserId: auth.actor.userId,
          action: 'document_created',
          metadata: { payslip_batch_id: batch.id, batch_item_id: item.id },
        });
        await dependencies.store.audit({
          organizationId,
          documentId: document.id,
          recipientId: recipients[0]!.id,
          actorUserId: auth.actor.userId,
          action: 'document_sent',
          metadata: { payslip_batch_id: batch.id, batch_item_id: item.id },
        });

        await notifyDocumentRecipients({
          notifications: dependencies.notifications,
          organizationId,
          actorUserId: auth.actor.userId,
          documentId: document.id,
          documentType: 'payslip',
          title,
          message: `Your ${batch.title} is available in your inbox.`,
          requiresAcknowledgement: false,
          recipients: [
            {
              userId: item.userId,
              email: member.email,
              fullName: member.full_name,
            },
          ],
        });

        await dependencies.store.updatePayslipBatchItem(organizationId, item.id, {
          matchStatus: 'delivered',
          documentId: document.id,
          recipientId: recipients[0]!.id,
          errorMessage: null,
        });
        delivered += 1;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown delivery error.';
        if (createdDocumentId) {
          await dependencies.store.updatePayslipBatchItem(organizationId, item.id, {
            matchStatus: 'delivered',
            documentId: createdDocumentId,
            errorMessage: `${message} (Delivered to inbox; a notification channel failed.)`,
          });
          delivered += 1;
        } else {
          await dependencies.store.updatePayslipBatchItem(organizationId, item.id, {
            matchStatus: 'failed',
            errorMessage: message,
          });
          failed += 1;
        }
      }
    }

    const status =
      failed > 0 ? (delivered > 0 ? 'partial_failed' : 'failed') : 'delivered';
    await dependencies.store.updatePayslipBatchStatus(
      organizationId,
      batchId,
      status,
      new Date(),
    );

    return c.json({ ok: true, delivered, failed });
  });

  return routes;
}
