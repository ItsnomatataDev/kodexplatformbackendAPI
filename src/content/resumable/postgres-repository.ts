import { db } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { ConflictError, NotFoundError, TooManyRequestsError } from '../../http/errors.js';
import type { MultipartPart } from '../../files/storage.js';
import type {
  CreateUploadSession,
  UploadSession,
  UploadSessionRepository,
  UploadState,
  UploadTarget,
} from './types.js';

type UploadSessionRow = {
  id: string;
  organization_id: string;
  created_by: string;
  target_type: UploadTarget['type'];
  schedule_id: string | null;
  client_id: string | null;
  office_id: string;
  target_metadata: Record<string, unknown>;
  bucket: string;
  object_key: string;
  provider_upload_id: string | null;
  original_filename: string;
  mime_type: string;
  expected_size_bytes: string | number;
  part_size_bytes: number;
  expected_part_count: number;
  media_record_id: string;
  asset_record_id: string | null;
  state: UploadState;
  completion_owner: string | null;
  completion_lease_until: Date | null;
  completion_result: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
};

type PartRow = {
  part_number: number;
  size_bytes: string | number;
  etag: string;
};

function targetFromRow(row: UploadSessionRow): UploadTarget {
  if (row.target_type === 'schedule_asset' && row.schedule_id) {
    return {
      type: 'schedule_asset',
      scheduleId: row.schedule_id,
      clientId: typeof row.target_metadata.clientId === 'string'
        ? row.target_metadata.clientId
        : null,
      officeId: row.office_id,
      displaySlot: Number(row.target_metadata.displaySlot ?? 0),
      heading: typeof row.target_metadata.heading === 'string'
        ? row.target_metadata.heading
        : null,
      caption: typeof row.target_metadata.caption === 'string'
        ? row.target_metadata.caption
        : null,
    };
  }
  if (row.target_type === 'client_media' && row.client_id) {
    return {
      type: 'client_media',
      clientId: row.client_id,
      officeId: row.office_id,
      label: typeof row.target_metadata.label === 'string'
        ? row.target_metadata.label
        : null,
    };
  }
  throw new Error('upload_session_target_corrupt');
}

function mapSession(row: UploadSessionRow): UploadSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    target: targetFromRow(row),
    bucket: row.bucket,
    objectKey: row.object_key,
    providerUploadId: row.provider_upload_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    expectedSizeBytes: Number(row.expected_size_bytes),
    partSizeBytes: row.part_size_bytes,
    expectedPartCount: row.expected_part_count,
    mediaRecordId: row.media_record_id,
    assetRecordId: row.asset_record_id,
    state: row.state,
    completionOwner: row.completion_owner,
    completionLeaseUntil: row.completion_lease_until,
    completionResult: row.completion_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  };
}

const SESSION_COLUMNS = `
  id, organization_id, created_by, target_type, schedule_id, client_id,
  office_id, target_metadata, bucket, object_key, provider_upload_id,
  original_filename, mime_type, expected_size_bytes, part_size_bytes,
  expected_part_count, media_record_id, asset_record_id, state,
  completion_owner, completion_lease_until, completion_result,
  created_at, updated_at, expires_at, completed_at, cancelled_at
`;

export class PostgresUploadSessionRepository implements UploadSessionRepository {
  async create(
    input: CreateUploadSession,
    limits: {
      maxActivePerUser: number;
      maxActivePerOrganization: number;
      maxReservedBytesPerUser: number;
      maxReservedBytesPerOrganization: number;
    },
  ) {
    return withTransaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`upload-quota:${input.organizationId}:${input.createdBy}`],
      );
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`upload-quota-org:${input.organizationId}`],
      );
      const totals = await client.query<{
        user_sessions: string;
        organization_sessions: string;
        user_bytes: string;
        organization_bytes: string;
      }>(
        `
          SELECT
            COUNT(*) FILTER (WHERE created_by = $2)::text AS user_sessions,
            COUNT(*)::text AS organization_sessions,
            COALESCE(SUM(expected_size_bytes) FILTER (WHERE created_by = $2), 0)::text AS user_bytes,
            COALESCE(SUM(expected_size_bytes), 0)::text AS organization_bytes
          FROM content.upload_sessions
          WHERE organization_id = $1
            AND state IN ('initiating', 'uploading', 'completing', 'aborting')
            AND expires_at > NOW()
        `,
        [input.organizationId, input.createdBy],
      );
      const row = totals.rows[0]!;
      if (
        Number(row.user_sessions) >= limits.maxActivePerUser ||
        Number(row.user_bytes) + input.expectedSizeBytes > limits.maxReservedBytesPerUser ||
        Number(row.organization_sessions) >= limits.maxActivePerOrganization ||
        Number(row.organization_bytes) + input.expectedSizeBytes >
          limits.maxReservedBytesPerOrganization
      ) {
        throw new TooManyRequestsError(
          3600,
          'Upload quota exceeded. Try again after active uploads finish or expire.',
        );
      }

      const targetType = input.target.type;
      const result = await client.query<UploadSessionRow>(
        `
          INSERT INTO content.upload_sessions (
            id, organization_id, created_by, target_type, schedule_id,
            client_id, office_id, target_metadata, bucket, object_key,
            original_filename, mime_type, expected_size_bytes,
            part_size_bytes, expected_part_count, media_record_id,
            asset_record_id, state, expires_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
            'initiating',$18
          )
          RETURNING ${SESSION_COLUMNS}
        `,
        [
          input.id,
          input.organizationId,
          input.createdBy,
          targetType,
          targetType === 'schedule_asset' ? input.target.scheduleId : null,
          targetType === 'client_media' ? input.target.clientId : null,
          input.target.officeId,
          targetType === 'schedule_asset'
            ? JSON.stringify({
                displaySlot: input.target.displaySlot,
                heading: input.target.heading,
                caption: input.target.caption,
              clientId: input.target.clientId,
            })
            : JSON.stringify({ label: input.target.label }),
          input.bucket,
          input.objectKey,
          input.originalFilename,
          input.mimeType,
          input.expectedSizeBytes,
          input.partSizeBytes,
          input.expectedPartCount,
          input.mediaRecordId,
          input.assetRecordId,
          input.expiresAt,
        ],
      );
      return mapSession(result.rows[0]!);
    });
  }

  async attachProviderUpload(sessionId: string, providerUploadId: string) {
    const result = await db.query(
      `UPDATE content.upload_sessions
       SET provider_upload_id = $2, state = 'uploading', updated_at = NOW()
       WHERE id = $1 AND state = 'initiating'`,
      [sessionId, providerUploadId],
    );
    if (result.rowCount !== 1) throw new ConflictError('UPLOAD_SESSION_CHANGED');
  }

  async failInitiation(sessionId: string) {
    await db.query(
      `UPDATE content.upload_sessions SET state = 'failed', updated_at = NOW()
       WHERE id = $1 AND state = 'initiating'`,
      [sessionId],
    );
  }

  async getOwned(organizationId: string, createdBy: string, sessionId: string) {
    const result = await db.query<UploadSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM content.upload_sessions
       WHERE id = $1 AND organization_id = $2 AND created_by = $3`,
      [sessionId, organizationId, createdBy],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async claimPart(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    partNumber: number,
    claimToken: string,
    leaseUntil: Date,
    limits: {
      maxPerSession: number;
      maxPerUser: number;
      maxPerOrganization: number;
      inactivityMs: number;
    },
  ) {
    return withTransaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`upload-part-quota:${organizationId}:${createdBy}`],
      );
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`upload-part-quota-org:${organizationId}`],
      );
      const selected = await client.query<UploadSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM content.upload_sessions
         WHERE id = $1 AND organization_id = $2 AND created_by = $3
         FOR UPDATE`,
        [sessionId, organizationId, createdBy],
      );
      if (!selected.rows[0]) throw new NotFoundError('UPLOAD_SESSION_NOT_FOUND');
      const session = mapSession(selected.rows[0]);
      if (
        session.state !== 'uploading' ||
        session.expiresAt.getTime() <= Date.now() ||
        !session.providerUploadId
      ) {
        throw new ConflictError('UPLOAD_SESSION_NOT_ACTIVE');
      }
      const active = await client.query<{
        session_count: string;
        user_count: string;
        organization_count: string;
      }>(
        `
          SELECT
            COUNT(*) FILTER (WHERE p.session_id = $1)::text AS session_count,
            COUNT(*) FILTER (WHERE s.created_by = $2)::text AS user_count,
            COUNT(*)::text AS organization_count
          FROM content.upload_session_parts p
          JOIN content.upload_sessions s ON s.id = p.session_id
          WHERE s.organization_id = $3
            AND p.state = 'uploading'
            AND p.lease_until > NOW()
        `,
        [sessionId, createdBy, organizationId],
      );
      const counts = active.rows[0]!;
      const current = await client.query<{ lease_until: Date | null; state: string }>(
        `SELECT state, lease_until FROM content.upload_session_parts
         WHERE session_id = $1 AND part_number = $2`,
        [sessionId, partNumber],
      );
      const prior = current.rows[0];
      if (prior?.state === 'uploading' && prior.lease_until && prior.lease_until > new Date()) {
        throw new ConflictError('UPLOAD_PART_IN_PROGRESS');
      }
      if (
        Number(counts.session_count) >= limits.maxPerSession ||
        Number(counts.user_count) >= limits.maxPerUser ||
        Number(counts.organization_count) >= limits.maxPerOrganization
      ) {
        throw new TooManyRequestsError(
          30,
          'Upload part concurrency limit reached. Retry shortly.',
        );
      }
      await client.query(
        `
          INSERT INTO content.upload_session_parts (
            session_id, part_number, size_bytes, etag, state, claim_token,
            lease_until, updated_at
          )
          VALUES ($1,$2,NULL,NULL,'uploading',$3,$4,NOW())
          ON CONFLICT (session_id, part_number) DO UPDATE SET
            state = 'uploading',
            size_bytes = NULL,
            etag = NULL,
            claim_token = EXCLUDED.claim_token,
            lease_until = EXCLUDED.lease_until,
            updated_at = NOW()
        `,
        [sessionId, partNumber, claimToken, leaseUntil],
      );
      await client.query(
        `UPDATE content.upload_sessions
         SET updated_at = NOW(), expires_at = $2
         WHERE id = $1 AND state = 'uploading'`,
        [sessionId, new Date(Date.now() + limits.inactivityMs)],
      );
      return { session, token: claimToken };
    });
  }

  async commitPart(
    sessionId: string,
    partNumber: number,
    claimToken: string,
    part: MultipartPart,
    expiresAt: Date,
  ) {
    await withTransaction(async (client) => {
      const result = await client.query(
        `
          UPDATE content.upload_session_parts
          SET size_bytes = $4, etag = $5, state = 'committed',
              claim_token = NULL, lease_until = NULL, updated_at = NOW()
          WHERE session_id = $1 AND part_number = $2
            AND claim_token = $3 AND state = 'uploading'
        `,
        [sessionId, partNumber, claimToken, part.sizeBytes, part.etag],
      );
      if (result.rowCount !== 1) throw new ConflictError('UPLOAD_PART_CLAIM_LOST');
      await client.query(
        `UPDATE content.upload_sessions SET updated_at = NOW(), expires_at = $2
         WHERE id = $1 AND state = 'uploading'`,
        [sessionId, expiresAt],
      );
    });
  }

  async releasePart(sessionId: string, partNumber: number, claimToken: string) {
    await db.query(
      `DELETE FROM content.upload_session_parts
       WHERE session_id = $1 AND part_number = $2
         AND claim_token = $3 AND state = 'uploading'`,
      [sessionId, partNumber, claimToken],
    );
  }

  async reconcileParts(sessionId: string, parts: MultipartPart[]) {
    const numbers = parts.map((part) => part.partNumber);
    await withTransaction(async (client) => {
      await client.query(
        `DELETE FROM content.upload_session_parts
         WHERE session_id = $1 AND state = 'committed'
           AND NOT (part_number = ANY($2::integer[]))`,
        [sessionId, numbers],
      );
      for (const part of parts) {
        await client.query(
          `
            INSERT INTO content.upload_session_parts (
              session_id, part_number, size_bytes, etag, state,
              claim_token, lease_until, updated_at
            )
            VALUES ($1,$2,$3,$4,'committed',NULL,NULL,NOW())
            ON CONFLICT (session_id, part_number) DO UPDATE SET
              size_bytes = EXCLUDED.size_bytes,
              etag = EXCLUDED.etag,
              state = 'committed',
              claim_token = NULL,
              lease_until = NULL,
              updated_at = NOW()
            WHERE content.upload_session_parts.state = 'committed'
               OR content.upload_session_parts.lease_until <= NOW()
          `,
          [sessionId, part.partNumber, part.sizeBytes, part.etag],
        );
      }
    });
  }

  async listParts(sessionId: string): Promise<MultipartPart[]> {
    const result = await db.query<PartRow>(
      `SELECT part_number, size_bytes, etag FROM content.upload_session_parts
       WHERE session_id = $1 AND state = 'committed'
       ORDER BY part_number`,
      [sessionId],
    );
    return result.rows.map((row) => ({
      partNumber: row.part_number,
      sizeBytes: Number(row.size_bytes),
      etag: row.etag,
    }));
  }

  async claimCompletion(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    claimToken: string,
    leaseUntil: Date,
  ) {
    return withTransaction(async (client) => {
      const result = await client.query<UploadSessionRow>(
        `
          UPDATE content.upload_sessions
          SET state = 'completing', completion_owner = $4,
              completion_lease_until = $5, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND created_by = $3
            AND (
              state = 'uploading'
              OR (state = 'completing' AND completion_lease_until <= NOW())
            )
            AND expires_at > NOW()
          RETURNING ${SESSION_COLUMNS}
        `,
        [sessionId, organizationId, createdBy, claimToken, leaseUntil],
      );
      if (result.rows[0]) {
        const activeParts = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM content.upload_session_parts
           WHERE session_id = $1 AND state = 'uploading' AND lease_until > NOW()`,
          [sessionId],
        );
        if (Number(activeParts.rows[0]?.count ?? 0) > 0) {
          throw new ConflictError('UPLOAD_PARTS_IN_PROGRESS');
        }
        return mapSession(result.rows[0]);
      }
      const existing = await client.query<UploadSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM content.upload_sessions
         WHERE id = $1 AND organization_id = $2 AND created_by = $3
         FOR UPDATE`,
        [sessionId, organizationId, createdBy],
      );
      if (!existing.rows[0]) throw new NotFoundError('UPLOAD_SESSION_NOT_FOUND');
      const session = mapSession(existing.rows[0]);
      if (session.state === 'completed') return session;
      if (session.state === 'completing') {
        throw new ConflictError('UPLOAD_COMPLETION_IN_PROGRESS');
      }
      throw new ConflictError('UPLOAD_SESSION_NOT_ACTIVE');
    });
  }

  async releaseCompletion(sessionId: string, claimToken: string) {
    await db.query(
      `UPDATE content.upload_sessions
       SET state = 'uploading', completion_owner = NULL,
           completion_lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND state = 'completing' AND completion_owner = $2`,
      [sessionId, claimToken],
    );
  }

  async releaseCancellation(sessionId: string, claimToken: string) {
    await db.query(
      `UPDATE content.upload_sessions
       SET state = CASE WHEN provider_upload_id IS NULL THEN 'initiating' ELSE 'uploading' END,
           completion_owner = NULL, completion_lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND state = 'aborting' AND completion_owner = $2`,
      [sessionId, claimToken],
    );
  }

  async markCompleted(
    sessionId: string,
    claimToken: string,
    resultValue: Record<string, unknown>,
  ) {
    const result = await db.query<UploadSessionRow>(
      `
        UPDATE content.upload_sessions
        SET state = 'completed', completion_result = $3,
            completed_at = NOW(), updated_at = NOW(),
            completion_owner = NULL, completion_lease_until = NULL
        WHERE id = $1 AND state = 'completing' AND completion_owner = $2
        RETURNING ${SESSION_COLUMNS}
      `,
      [sessionId, claimToken, JSON.stringify(resultValue)],
    );
    if (result.rows[0]) return mapSession(result.rows[0]);
    const current = await db.query<UploadSessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM content.upload_sessions WHERE id = $1`,
      [sessionId],
    );
    if (current.rows[0]?.state === 'completed') return mapSession(current.rows[0]);
    throw new ConflictError('UPLOAD_COMPLETION_CLAIM_LOST');
  }

  async markRecoveredCompleted(
    sessionId: string,
    claimToken: string,
    resultValue: Record<string, unknown>,
  ) {
    const result = await db.query(
      `
        UPDATE content.upload_sessions
        SET state = 'completed', completion_result = $3,
            completed_at = COALESCE(completed_at, NOW()), updated_at = NOW(),
            completion_owner = NULL, completion_lease_until = NULL
        WHERE id = $1 AND state IN ('aborting', 'completing')
          AND completion_owner = $2
      `,
      [sessionId, claimToken, JSON.stringify(resultValue)],
    );
    if (result.rowCount !== 1) throw new ConflictError('UPLOAD_RECOVERY_CLAIM_LOST');
  }

  async claimStaleCompletions(limit: number) {
    return withTransaction(async (client) => {
      const result = await client.query<UploadSessionRow>(
        `
          WITH stale AS (
            SELECT id FROM content.upload_sessions
            WHERE state = 'completing'
              AND completion_lease_until <= NOW()
              AND expires_at > NOW()
            ORDER BY completion_lease_until
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          )
          UPDATE content.upload_sessions s
          SET completion_owner = gen_random_uuid(),
              completion_lease_until = NOW() + INTERVAL '40 minutes',
              updated_at = NOW()
          FROM stale
          WHERE s.id = stale.id
          RETURNING ${SESSION_COLUMNS.split(',').map((column) => `s.${column.trim()}`).join(', ')}
        `,
        [limit],
      );
      return result.rows.map(mapSession);
    });
  }

  async releaseStaleCompletion(sessionId: string, claimToken: string) {
    await db.query(
      `
        UPDATE content.upload_sessions
        SET state = 'uploading', completion_owner = NULL,
            completion_lease_until = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'completing' AND completion_owner = $2
      `,
      [sessionId, claimToken],
    );
  }

  async claimCancellation(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    claimToken: string,
    leaseUntil: Date,
  ) {
    return withTransaction(async (client) => {
      const result = await client.query<UploadSessionRow>(
        `
          UPDATE content.upload_sessions
          SET state = 'aborting', completion_owner = $4,
              completion_lease_until = $5, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND created_by = $3
            AND (
              state IN ('initiating', 'uploading')
              OR (state = 'aborting' AND completion_lease_until <= NOW())
            )
          RETURNING ${SESSION_COLUMNS}
        `,
        [sessionId, organizationId, createdBy, claimToken, leaseUntil],
      );
      if (result.rows[0]) {
        const activeParts = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM content.upload_session_parts
           WHERE session_id = $1 AND state = 'uploading' AND lease_until > NOW()`,
          [sessionId],
        );
        if (Number(activeParts.rows[0]?.count ?? 0) > 0) {
          throw new ConflictError('UPLOAD_PARTS_IN_PROGRESS');
        }
        return mapSession(result.rows[0]);
      }
      const existing = await client.query<UploadSessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM content.upload_sessions
         WHERE id = $1 AND organization_id = $2 AND created_by = $3
         FOR UPDATE`,
        [sessionId, organizationId, createdBy],
      );
      if (!existing.rows[0]) throw new NotFoundError('UPLOAD_SESSION_NOT_FOUND');
      const session = mapSession(existing.rows[0]);
      if (session.state === 'completed') {
        throw new ConflictError('UPLOAD_ALREADY_COMPLETED');
      }
      if (session.state === 'aborted') return session;
      throw new ConflictError('UPLOAD_SESSION_BUSY');
    });
  }

  async markCancelled(sessionId: string, claimToken: string) {
    const result = await db.query(
      `
        UPDATE content.upload_sessions
        SET state = 'aborted', cancelled_at = COALESCE(cancelled_at, NOW()),
            updated_at = NOW(), completion_owner = NULL,
            completion_lease_until = NULL
        WHERE id = $1 AND state = 'aborting' AND completion_owner = $2
      `,
      [sessionId, claimToken],
    );
    if (result.rowCount !== 1) throw new ConflictError('UPLOAD_CANCELLATION_CLAIM_LOST');
  }

  async claimExpired(limit: number) {
    return withTransaction(async (client) => {
      const result = await client.query<UploadSessionRow>(
        `
          WITH expired AS (
            SELECT id FROM content.upload_sessions
            WHERE expires_at <= NOW()
              AND state IN ('initiating', 'uploading', 'completing', 'aborting')
              AND (completion_lease_until IS NULL OR completion_lease_until <= NOW())
            ORDER BY expires_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          )
          UPDATE content.upload_sessions s
          SET state = 'aborting', updated_at = NOW(),
              completion_owner = gen_random_uuid(),
              completion_lease_until = NOW() + INTERVAL '10 minutes'
          FROM expired
          WHERE s.id = expired.id
          RETURNING ${SESSION_COLUMNS.split(',').map((column) => `s.${column.trim()}`).join(', ')}
        `,
        [limit],
      );
      return result.rows.map(mapSession);
    });
  }

  async markExpired(sessionId: string, claimToken: string) {
    await db.query(
      `UPDATE content.upload_sessions
       SET state = 'expired', updated_at = NOW(),
           completion_owner = NULL, completion_lease_until = NULL
       WHERE id = $1 AND state = 'aborting' AND completion_owner = $2`,
      [sessionId, claimToken],
    );
  }

  async claimRecoverableInitiations(limit: number) {
    return withTransaction(async (client) => {
      const result = await client.query<UploadSessionRow>(
        `
          WITH stale AS (
            SELECT id FROM content.upload_sessions
            WHERE state = 'initiating' AND expires_at > NOW()
              AND updated_at < NOW() - INTERVAL '1 minute'
            ORDER BY updated_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1
          )
          UPDATE content.upload_sessions s
          SET state = 'completing', completion_owner = gen_random_uuid(),
              completion_lease_until = NOW() + INTERVAL '5 minutes',
              updated_at = NOW()
          FROM stale
          WHERE s.id = stale.id
          RETURNING ${SESSION_COLUMNS.split(',').map((column) => `s.${column.trim()}`).join(', ')}
        `,
        [limit],
      );
      return result.rows.map(mapSession);
    });
  }

  async completeInitiationRecovery(
    sessionId: string,
    claimToken: string,
    providerUploadId: string,
  ) {
    const result = await db.query(
      `
        UPDATE content.upload_sessions
        SET state = 'uploading', provider_upload_id = $3,
            completion_owner = NULL, completion_lease_until = NULL,
            updated_at = NOW()
        WHERE id = $1 AND state = 'completing' AND completion_owner = $2
      `,
      [sessionId, claimToken, providerUploadId],
    );
    if (result.rowCount !== 1) throw new ConflictError('UPLOAD_RECOVERY_CLAIM_LOST');
  }

  async releaseInitiationRecovery(sessionId: string, claimToken: string) {
    await db.query(
      `
        UPDATE content.upload_sessions
        SET state = 'initiating', completion_owner = NULL,
            completion_lease_until = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'completing' AND completion_owner = $2
      `,
      [sessionId, claimToken],
    );
  }

  async purgeTerminal(retentionMs: number, limit: number) {
    const result = await db.query(
      `
        WITH terminal AS (
          SELECT id
          FROM content.upload_sessions
          WHERE state IN ('completed', 'aborted', 'expired', 'failed')
            AND updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
          ORDER BY updated_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM content.upload_sessions s
        USING terminal
        WHERE s.id = terminal.id
      `,
      [retentionMs, limit],
    );
    return result.rowCount ?? 0;
  }
}
