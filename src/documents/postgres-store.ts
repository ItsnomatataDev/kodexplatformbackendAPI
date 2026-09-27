import { keysetPredicate, listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

export type EmployeeDocumentRecord = {
  id: string;
  organizationId: string;
  title: string;
  message: string | null;
  documentType: string;
  fileBucket: string | null;
  filePath: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  requiresAcknowledgement: boolean;
  isConfidential: boolean;
  createdBy: string | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type EmployeeDocumentRecipientRecord = {
  id: string;
  organizationId: string;
  documentId: string;
  userId: string;
  status: 'unread' | 'read' | 'acknowledged' | 'archived';
  deliveredAt: Date;
  readAt: Date | null;
  acknowledgedAt: Date | null;
  archivedAt: Date | null;
  acknowledgementNote: string | null;
  createdAt: Date;
  document: EmployeeDocumentRecord;
};

function mapDocument(row: Record<string, unknown>): EmployeeDocumentRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    title: row.title as string,
    message: (row.message as string | null) ?? null,
    documentType: row.document_type as string,
    fileBucket: (row.file_bucket as string | null) ?? null,
    filePath: (row.file_path as string | null) ?? null,
    fileName: (row.file_name as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined
        ? null
        : Number(row.size_bytes),
    requiresAcknowledgement: Boolean(row.requires_acknowledgement),
    isConfidential: Boolean(row.is_confidential),
    createdBy: (row.created_by as string | null) ?? null,
    expiresAt: (row.expires_at as Date | null) ?? null,
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapRecipient(
  row: Record<string, unknown>,
  document: EmployeeDocumentRecord,
): EmployeeDocumentRecipientRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    documentId: row.document_id as string,
    userId: row.user_id as string,
    status: row.status as EmployeeDocumentRecipientRecord['status'],
    deliveredAt: row.delivered_at as Date,
    readAt: (row.read_at as Date | null) ?? null,
    acknowledgedAt: (row.acknowledged_at as Date | null) ?? null,
    archivedAt: (row.archived_at as Date | null) ?? null,
    acknowledgementNote: (row.acknowledgement_note as string | null) ?? null,
    createdAt: row.created_at as Date,
    document,
  };
}

function mapInboxRow(row: Record<string, unknown>) {
  const document = mapDocument({
    id: row.d_id,
    organization_id: row.d_organization_id,
    title: row.d_title,
    message: row.d_message,
    document_type: row.d_document_type,
    file_bucket: row.d_file_bucket,
    file_path: row.d_file_path,
    file_name: row.d_file_name,
    mime_type: row.d_mime_type,
    size_bytes: row.d_size_bytes,
    requires_acknowledgement: row.d_requires_acknowledgement,
    is_confidential: row.d_is_confidential,
    created_by: row.d_created_by,
    expires_at: row.d_expires_at,
    metadata: row.d_metadata,
    created_at: row.d_created_at,
    updated_at: row.d_updated_at,
  });
  return mapRecipient(row, document);
}

export class PostgresDocumentsStore {
  async countUnread(organizationId: string, userId: string) {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM documents.employee_document_recipients
       WHERE organization_id = $1 AND user_id = $2 AND status = 'unread'`,
      [organizationId, userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listMine(params: {
    organizationId: string;
    userId: string;
    status?: string | null;
    documentType?: string | null;
    limit?: number;
    before?: string;
    beforeId?: string;
  }) {
    const limit = listLimit(params.limit);
    const values: unknown[] = [params.organizationId, params.userId];
    let filter = '';
    if (params.status && params.status !== 'all') {
      values.push(params.status);
      filter += ` AND r.status = $${values.length}`;
    }
    if (params.documentType && params.documentType !== 'all') {
      values.push(params.documentType);
      filter += ` AND d.document_type = $${values.length}`;
    }
    filter += keysetPredicate(
      values,
      { at: params.before, id: params.beforeId },
      'r.delivered_at',
      'r.id',
    );
    values.push(limit + 1);

    const result = await db.query(
      `SELECT r.*,
              d.id AS d_id,
              d.organization_id AS d_organization_id,
              d.title AS d_title,
              d.message AS d_message,
              d.document_type AS d_document_type,
              d.file_bucket AS d_file_bucket,
              d.file_path AS d_file_path,
              d.file_name AS d_file_name,
              d.mime_type AS d_mime_type,
              d.size_bytes AS d_size_bytes,
              d.requires_acknowledgement AS d_requires_acknowledgement,
              d.is_confidential AS d_is_confidential,
              d.created_by AS d_created_by,
              d.expires_at AS d_expires_at,
              d.metadata AS d_metadata,
              d.created_at AS d_created_at,
              d.updated_at AS d_updated_at
       FROM documents.employee_document_recipients r
       JOIN documents.employee_documents d ON d.id = r.document_id
       WHERE r.organization_id = $1
         AND r.user_id = $2
         ${filter}
       ORDER BY r.delivered_at DESC, r.id DESC
       LIMIT $${values.length}`,
      values,
    );

    const mapped = result.rows.map((row) => mapInboxRow(row));
    const page = pageOf(mapped, limit);
    return { documents: page.rows, hasMore: page.hasMore };
  }

  async getMine(
    organizationId: string,
    userId: string,
    recipientId: string,
  ) {
    const result = await db.query(
      `SELECT r.*,
              d.id AS d_id,
              d.organization_id AS d_organization_id,
              d.title AS d_title,
              d.message AS d_message,
              d.document_type AS d_document_type,
              d.file_bucket AS d_file_bucket,
              d.file_path AS d_file_path,
              d.file_name AS d_file_name,
              d.mime_type AS d_mime_type,
              d.size_bytes AS d_size_bytes,
              d.requires_acknowledgement AS d_requires_acknowledgement,
              d.is_confidential AS d_is_confidential,
              d.created_by AS d_created_by,
              d.expires_at AS d_expires_at,
              d.metadata AS d_metadata,
              d.created_at AS d_created_at,
              d.updated_at AS d_updated_at
       FROM documents.employee_document_recipients r
       JOIN documents.employee_documents d ON d.id = r.document_id
       WHERE r.organization_id = $1
         AND r.user_id = $2
         AND r.id = $3
       LIMIT 1`,
      [organizationId, userId, recipientId],
    );
    return result.rows[0] ? mapInboxRow(result.rows[0]) : null;
  }

  async markRead(
    organizationId: string,
    userId: string,
    recipientId: string,
  ) {
    const result = await db.query(
      `UPDATE documents.employee_document_recipients
       SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
           read_at = COALESCE(read_at, NOW())
       WHERE id = $1 AND organization_id = $2 AND user_id = $3
       RETURNING *`,
      [recipientId, organizationId, userId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'DOCUMENT_RECIPIENT_NOT_FOUND',
        'Document was not found.',
      );
    }
    await this.audit({
      organizationId,
      documentId: result.rows[0].document_id as string,
      recipientId,
      actorUserId: userId,
      action: 'document_read',
    });
    return this.getMine(organizationId, userId, recipientId);
  }

  async acknowledge(
    organizationId: string,
    userId: string,
    recipientId: string,
    note?: string | null,
  ) {
    const result = await db.query(
      `UPDATE documents.employee_document_recipients
       SET status = 'acknowledged',
           read_at = COALESCE(read_at, NOW()),
           acknowledged_at = NOW(),
           acknowledgement_note = $4
       WHERE id = $1 AND organization_id = $2 AND user_id = $3
       RETURNING *`,
      [recipientId, organizationId, userId, note ?? null],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'DOCUMENT_RECIPIENT_NOT_FOUND',
        'Document was not found.',
      );
    }
    await this.audit({
      organizationId,
      documentId: result.rows[0].document_id as string,
      recipientId,
      actorUserId: userId,
      action: 'document_acknowledged',
      metadata: note ? { note } : {},
    });
    return this.getMine(organizationId, userId, recipientId);
  }

  async audit(input: {
    organizationId: string;
    documentId: string;
    recipientId?: string | null;
    actorUserId?: string | null;
    action: string;
    metadata?: Record<string, unknown>;
  }) {
    await db.query(
      `INSERT INTO documents.employee_document_audit_logs (
         organization_id, document_id, recipient_id, actor_user_id, action, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        input.organizationId,
        input.documentId,
        input.recipientId ?? null,
        input.actorUserId ?? null,
        input.action,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async createDocument(input: {
    id?: string;
    organizationId: string;
    title: string;
    message?: string | null;
    documentType: string;
    fileBucket?: string | null;
    filePath?: string | null;
    fileName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    requiresAcknowledgement?: boolean;
    isConfidential?: boolean;
    createdBy: string;
    metadata?: Record<string, unknown>;
  }) {
    const result = await db.query(
      `INSERT INTO documents.employee_documents (
         id, organization_id, title, message, document_type, file_bucket, file_path,
         file_name, mime_type, size_bytes, requires_acknowledgement, is_confidential,
         created_by, metadata
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb
       )
       RETURNING *`,
      [
        input.id ?? null,
        input.organizationId,
        input.title,
        input.message ?? null,
        input.documentType,
        input.fileBucket ?? 'employee-documents',
        input.filePath ?? null,
        input.fileName ?? null,
        input.mimeType ?? null,
        input.sizeBytes ?? null,
        Boolean(input.requiresAcknowledgement),
        input.isConfidential ?? true,
        input.createdBy,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapDocument(result.rows[0]!);
  }

  async createRecipients(input: {
    organizationId: string;
    documentId: string;
    userIds: string[];
  }) {
    const created: Array<{ id: string; userId: string }> = [];
    for (const userId of input.userIds) {
      const result = await db.query(
        `INSERT INTO documents.employee_document_recipients (
           organization_id, document_id, user_id, status
         ) VALUES ($1,$2,$3,'unread')
         ON CONFLICT (document_id, user_id) DO NOTHING
         RETURNING id, user_id`,
        [input.organizationId, input.documentId, userId],
      );
      if (result.rows[0]) {
        created.push({
          id: result.rows[0].id as string,
          userId: result.rows[0].user_id as string,
        });
      }
    }
    return created;
  }

  async countRecipientsForDocument(documentId: string) {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM documents.employee_document_recipients
       WHERE document_id = $1`,
      [documentId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listAdminDeliveries(
    organizationId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'r.delivered_at',
      'r.id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT r.*,
              d.id AS d_id,
              d.organization_id AS d_organization_id,
              d.title AS d_title,
              d.message AS d_message,
              d.document_type AS d_document_type,
              d.file_bucket AS d_file_bucket,
              d.file_path AS d_file_path,
              d.file_name AS d_file_name,
              d.mime_type AS d_mime_type,
              d.size_bytes AS d_size_bytes,
              d.requires_acknowledgement AS d_requires_acknowledgement,
              d.is_confidential AS d_is_confidential,
              d.created_by AS d_created_by,
              d.expires_at AS d_expires_at,
              d.metadata AS d_metadata,
              d.created_at AS d_created_at,
              d.updated_at AS d_updated_at,
              p.full_name AS user_name,
              u.email AS user_email
       FROM documents.employee_document_recipients r
       JOIN documents.employee_documents d ON d.id = r.document_id
       LEFT JOIN identity.users u ON u.id = r.user_id
       LEFT JOIN identity.user_profiles p ON p.user_id = r.user_id
       WHERE r.organization_id = $1
         ${cursor}
       ORDER BY r.delivered_at DESC, r.id DESC
       LIMIT $${params.length}`,
      params,
    );

    const mapped = result.rows.map((row) => {
      const document = mapDocument({
        id: row.d_id,
        organization_id: row.d_organization_id,
        title: row.d_title,
        message: row.d_message,
        document_type: row.d_document_type,
        file_bucket: row.d_file_bucket,
        file_path: row.d_file_path,
        file_name: row.d_file_name,
        mime_type: row.d_mime_type,
        size_bytes: row.d_size_bytes,
        requires_acknowledgement: row.d_requires_acknowledgement,
        is_confidential: row.d_is_confidential,
        created_by: row.d_created_by,
        expires_at: row.d_expires_at,
        metadata: row.d_metadata,
        created_at: row.d_created_at,
        updated_at: row.d_updated_at,
      });
      return {
        ...mapRecipient(row, document),
        userName: (row.user_name as string | null) ?? null,
        userEmail: (row.user_email as string | null) ?? null,
      };
    });
    const paged = pageOf(mapped, limit);
    return { deliveries: paged.rows, hasMore: paged.hasMore };
  }

  async getRecipientById(organizationId: string, recipientId: string) {
    const result = await db.query(
      `SELECT * FROM documents.employee_document_recipients
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, recipientId],
    );
    return result.rows[0] ?? null;
  }

  async deleteRecipient(organizationId: string, recipientId: string) {
    const result = await db.query(
      `DELETE FROM documents.employee_document_recipients
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [organizationId, recipientId],
    );
    return result.rows[0] ?? null;
  }

  async createPayslipBatch(input: {
    organizationId: string;
    title: string;
    payrollMonth: number;
    payrollYear: number;
    createdBy: string;
  }) {
    const result = await db.query(
      `INSERT INTO documents.payslip_batches (
         organization_id, title, payroll_month, payroll_year, created_by, status
       ) VALUES ($1,$2,$3,$4,$5,'draft')
       RETURNING *`,
      [
        input.organizationId,
        input.title,
        input.payrollMonth,
        input.payrollYear,
        input.createdBy,
      ],
    );
    return mapPayslipBatch(result.rows[0]!);
  }

  async listPayslipBatches(
    organizationId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit, 40);
    const params: unknown[] = [organizationId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT * FROM documents.payslip_batches
       WHERE organization_id = $1
         ${cursor}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map(mapPayslipBatch), limit);
    return { batches: paged.rows, hasMore: paged.hasMore };
  }

  async getPayslipBatch(organizationId: string, batchId: string) {
    const result = await db.query(
      `SELECT * FROM documents.payslip_batches
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, batchId],
    );
    return result.rows[0] ? mapPayslipBatch(result.rows[0]) : null;
  }

  async updatePayslipBatchStatus(
    organizationId: string,
    batchId: string,
    status: string,
    completedAt?: Date | null,
  ) {
    await db.query(
      `UPDATE documents.payslip_batches
       SET status = $3,
           completed_at = COALESCE($4, completed_at),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, batchId, status, completedAt ?? null],
    );
  }

  async deletePayslipBatch(organizationId: string, batchId: string) {
    const delivered = await db.query(
      `SELECT id FROM documents.payslip_batch_items
       WHERE organization_id = $1
         AND batch_id = $2
         AND (match_status = 'delivered' OR document_id IS NOT NULL)
       LIMIT 1`,
      [organizationId, batchId],
    );
    if (delivered.rows[0]) {
      throw new ValidationError(
        'This batch has delivered payslips. Delivered documents are kept — delete is blocked so inboxes are not emptied.',
      );
    }
    const result = await db.query(
      `DELETE FROM documents.payslip_batches
       WHERE organization_id = $1 AND id = $2
       RETURNING id`,
      [organizationId, batchId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createPayslipBatchItem(input: {
    organizationId: string;
    batchId: string;
    userId?: string | null;
    employeeEmail?: string | null;
    employeeName?: string | null;
    fileName: string;
    filePath?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    matchStatus: string;
    errorMessage?: string | null;
  }) {
    const result = await db.query(
      `INSERT INTO documents.payslip_batch_items (
         organization_id, batch_id, user_id, employee_email, employee_name,
         file_name, file_path, mime_type, size_bytes, match_status, error_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.organizationId,
        input.batchId,
        input.userId ?? null,
        input.employeeEmail ?? null,
        input.employeeName ?? null,
        input.fileName,
        input.filePath ?? null,
        input.mimeType ?? null,
        input.sizeBytes ?? null,
        input.matchStatus,
        input.errorMessage ?? null,
      ],
    );
    return mapPayslipBatchItem(result.rows[0]!);
  }

  async listPayslipBatchItems(
    organizationId: string,
    batchId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId, batchId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
      'asc',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT * FROM documents.payslip_batch_items
       WHERE organization_id = $1 AND batch_id = $2
         ${cursor}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map(mapPayslipBatchItem), limit);
    return { items: paged.rows, hasMore: paged.hasMore };
  }

  async getPayslipBatchItem(organizationId: string, itemId: string) {
    const result = await db.query(
      `SELECT * FROM documents.payslip_batch_items
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, itemId],
    );
    return result.rows[0] ? mapPayslipBatchItem(result.rows[0]) : null;
  }

  async updatePayslipBatchItem(
    organizationId: string,
    itemId: string,
    patch: {
      userId?: string | null;
      clearUser?: boolean;
      employeeEmail?: string | null;
      employeeName?: string | null;
      filePath?: string | null;
      matchStatus?: string;
      errorMessage?: string | null;
      documentId?: string | null;
      recipientId?: string | null;
    },
  ) {
    const result = await db.query(
      `UPDATE documents.payslip_batch_items
       SET user_id = CASE
             WHEN $3::boolean THEN $4::uuid
             ELSE user_id
           END,
           employee_email = CASE WHEN $5::boolean THEN $6 ELSE employee_email END,
           employee_name = CASE WHEN $7::boolean THEN $8 ELSE employee_name END,
           file_path = CASE WHEN $9::boolean THEN $10 ELSE file_path END,
           match_status = COALESCE($11, match_status),
           error_message = CASE WHEN $12::boolean THEN $13 ELSE error_message END,
           document_id = COALESCE($14, document_id),
           recipient_id = COALESCE($15, recipient_id),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        itemId,
        patch.userId !== undefined || patch.clearUser === true,
        patch.userId ?? null,
        patch.employeeEmail !== undefined,
        patch.employeeEmail ?? null,
        patch.employeeName !== undefined,
        patch.employeeName ?? null,
        patch.filePath !== undefined,
        patch.filePath ?? null,
        patch.matchStatus ?? null,
        patch.errorMessage !== undefined,
        patch.errorMessage ?? null,
        patch.documentId ?? null,
        patch.recipientId ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'PAYSLIP_ITEM_NOT_FOUND',
        'Payslip batch item was not found.',
      );
    }
    return mapPayslipBatchItem(result.rows[0]);
  }

  async listActiveOrgMembers(
    organizationId: string,
    page: { limit?: number; offset?: number; officeId?: string | null } = {},
  ) {
    const result = await db.query<{
      user_id: string;
      email: string | null;
      full_name: string | null;
      role_key: string | null;
      department: string | null;
      office_id: string | null;
      office_name: string | null;
      office_slug: string | null;
      account_status: string | null;
    }>(
      `SELECT
         m.user_id,
         u.email,
         p.full_name,
         m.role_key,
         p.department,
         m.office_id,
         o.name AS office_name,
         o.slug AS office_slug,
         u.account_status
       FROM organizations.memberships m
       JOIN identity.users u ON u.id = m.user_id
       LEFT JOIN identity.user_profiles p ON p.user_id = m.user_id
       LEFT JOIN organizations.offices o ON o.id = m.office_id
       WHERE m.organization_id = $1
         AND m.status = 'active'
         AND (u.account_status IS NULL OR u.account_status = 'active')
         AND COALESCE(p.is_suspended, FALSE) = FALSE
         AND ($2::uuid IS NULL OR m.office_id = $2)
       ORDER BY p.full_name NULLS LAST, u.email NULLS LAST, m.user_id ASC
       LIMIT $3 OFFSET $4`,
      [
        organizationId,
        page.officeId ?? null,
        listLimit(page.limit) + 1,
        listOffset(page.offset),
      ],
    );
    const mapped = result.rows.map((row) => ({
      id: row.user_id,
      full_name: row.full_name,
      email: row.email,
      primary_role: row.role_key,
      department: row.department,
      office_id: row.office_id,
      account_status: row.account_status,
      is_suspended: false,
      office: row.office_id
        ? {
            id: row.office_id,
            name: row.office_name,
            slug: row.office_slug,
          }
        : null,
    }));
    const pageResult = pageOf(mapped, listLimit(page.limit));
    return { members: pageResult.rows, hasMore: pageResult.hasMore };
  }

  async getActiveOrgMember(organizationId: string, userId: string) {
    const page = await this.listActiveMembersMatching(organizationId, {
      userId,
      limit: 1,
    });
    return page.members[0] ?? null;
  }

  async listActiveMembersByIds(organizationId: string, userIds: string[]) {
    if (userIds.length === 0) return [];
    const page = await this.listActiveMembersMatching(organizationId, {
      userIds: userIds.slice(0, listLimit(userIds.length)),
      limit: listLimit(userIds.length),
    });
    return page.members;
  }

  private async listActiveMembersMatching(
    organizationId: string,
    filter: { userId?: string; userIds?: string[]; limit: number },
  ) {
    const params: unknown[] = [organizationId];
    let identity = '';
    if (filter.userId) {
      params.push(filter.userId);
      identity = `AND m.user_id = $${params.length}`;
    } else if (filter.userIds) {
      params.push(filter.userIds);
      identity = `AND m.user_id = ANY($${params.length}::uuid[])`;
    }
    params.push(filter.limit);
    const result = await db.query<{
      user_id: string;
      email: string | null;
      full_name: string | null;
      role_key: string | null;
      department: string | null;
      office_id: string | null;
      office_name: string | null;
      office_slug: string | null;
      account_status: string | null;
    }>(
      `SELECT
         m.user_id,
         u.email,
         p.full_name,
         m.role_key,
         p.department,
         m.office_id,
         o.name AS office_name,
         o.slug AS office_slug,
         u.account_status
       FROM organizations.memberships m
       JOIN identity.users u ON u.id = m.user_id
       LEFT JOIN identity.user_profiles p ON p.user_id = m.user_id
       LEFT JOIN organizations.offices o ON o.id = m.office_id
       WHERE m.organization_id = $1
         AND m.status = 'active'
         AND (u.account_status IS NULL OR u.account_status = 'active')
         AND COALESCE(p.is_suspended, FALSE) = FALSE
         ${identity}
       ORDER BY m.user_id ASC
       LIMIT $${params.length}`,
      params,
    );
    return {
      members: result.rows.map((row) => ({
        id: row.user_id,
        full_name: row.full_name,
        email: row.email,
        primary_role: row.role_key,
        department: row.department,
        office_id: row.office_id,
        account_status: row.account_status,
        is_suspended: false,
        office: row.office_id
          ? {
              id: row.office_id,
              name: row.office_name,
              slug: row.office_slug,
            }
          : null,
      })),
    };
  }
}

export type PayslipBatchRecord = {
  id: string;
  organizationId: string;
  title: string;
  payrollMonth: number;
  payrollYear: number;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
};

export type PayslipBatchItemRecord = {
  id: string;
  organizationId: string;
  batchId: string;
  userId: string | null;
  employeeEmail: string | null;
  employeeName: string | null;
  documentId: string | null;
  recipientId: string | null;
  fileName: string;
  filePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  matchStatus: string;
  errorMessage: string | null;
  createdAt: Date;
};

function mapPayslipBatch(row: Record<string, unknown>): PayslipBatchRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    title: row.title as string,
    payrollMonth: Number(row.payroll_month),
    payrollYear: Number(row.payroll_year),
    status: row.status as string,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as Date,
    completedAt: (row.completed_at as Date | null) ?? null,
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
  };
}

function mapPayslipBatchItem(row: Record<string, unknown>): PayslipBatchItemRecord {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    batchId: row.batch_id as string,
    userId: (row.user_id as string | null) ?? null,
    employeeEmail: (row.employee_email as string | null) ?? null,
    employeeName: (row.employee_name as string | null) ?? null,
    documentId: (row.document_id as string | null) ?? null,
    recipientId: (row.recipient_id as string | null) ?? null,
    fileName: (row.file_name as string) ?? '',
    filePath: (row.file_path as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined
        ? null
        : Number(row.size_bytes),
    matchStatus: (row.match_status as string) ?? 'unmatched',
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}
