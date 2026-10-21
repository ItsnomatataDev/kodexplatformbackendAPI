import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  ValidationError,
} from '../../http/errors.js';
import type { MultipartFileStorage, MultipartPart } from '../../files/storage.js';
import type { ContentStore } from '../store.js';
import { logger } from '../../config/logger.js';
import {
  CONTENT_ASSET_KEEP_UNTIL,
  CONTENT_REVIEW_ASSETS_BUCKET,
  contentAssetTypeFromMime,
  contentClientObjectKey,
  contentScheduleObjectKey,
} from '../buckets.js';
import type {
  CreateUploadSession,
  PublicUploadSession,
  UploadSession,
  UploadSessionRepository,
  UploadTarget,
} from './types.js';

const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;
const COMPLETION_LEASE_MS = 40 * 60_000;
const PART_LEASE_MS = 40 * 60_000;

export const RESUMABLE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

export type ResumableUploadConfig = {
  enabled: boolean;
  maxFileBytes: number;
  partSizeBytes: number;
  sessionInactivityMs: number;
  terminalRetentionMs: number;
  maxActiveSessionsPerUser: number;
  maxActiveSessionsPerOrganization: number;
  maxReservedBytesPerUser: number;
  maxReservedBytesPerOrganization: number;
  maxConcurrentPartsPerSession: number;
  maxConcurrentPartsPerUser: number;
  maxConcurrentPartsPerOrganization: number;
};

export type CreateResumableUploadInput = {
  organizationId: string;
  createdBy: string;
  target: UploadTarget;
  originalFilename: string;
  mimeType: string;
  expectedSizeBytes: number;
};

function publicParts(parts: MultipartPart[]) {
  return parts.map(({ partNumber, sizeBytes }) => ({ partNumber, sizeBytes }));
}

export function publicUploadSession(
  session: UploadSession,
  parts: MultipartPart[],
): PublicUploadSession {
  return {
    sessionId: session.id,
    state: session.state,
    targetType: session.target.type,
    fileName: session.originalFilename,
    mimeType: session.mimeType,
    fileSizeBytes: session.expectedSizeBytes,
    partSizeBytes: session.partSizeBytes,
    partCount: session.expectedPartCount,
    expiresAt: session.expiresAt.toISOString(),
    committedParts: publicParts(parts),
    ...(session.completionResult ? { result: session.completionResult } : {}),
  };
}

function mediaPrefixMatches(mimeType: string, prefix: Uint8Array) {
  const ascii = String.fromCharCode(...prefix.subarray(0, Math.min(prefix.length, 512)));
  const starts = (...bytes: number[]) =>
    bytes.every((byte, index) => prefix[index] === byte);

  switch (mimeType) {
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/gif':
      return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'image/webp':
      return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'image/avif':
      return ascii.slice(4, 8) === 'ftyp' && /^(avif|avis)$/.test(ascii.slice(8, 12));
    case 'image/svg+xml': {
      const normalized = ascii.replace(/^\uFEFF/, '').trimStart();
      return (
        /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(normalized) &&
        !/<!DOCTYPE|<!ENTITY/i.test(normalized)
      );
    }
    case 'video/mp4':
      return (
        ascii.slice(4, 8) === 'ftyp' &&
        /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(ascii.slice(8, 12))
      );
    case 'video/quicktime':
      return ascii.slice(4, 8) === 'ftyp' && ascii.slice(8, 10) === 'qt';
    case 'video/webm':
    case 'video/x-matroska':
      return starts(0x1a, 0x45, 0xdf, 0xa3);
    case 'video/x-msvideo':
      return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ';
    default:
      return false;
  }
}

function validateStream(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
  mimeType: string,
  validateSignature: boolean,
) {
  let observedBytes = 0;
  let prefix = new Uint8Array(0);
  let pending: Uint8Array[] = [];
  let signatureChecked = !validateSignature;

  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observedBytes += chunk.byteLength;
        if (observedBytes > expectedBytes) {
          throw new PayloadTooLargeError('Upload part exceeded its expected size.');
        }
        if (!signatureChecked) {
          pending.push(chunk);
          const remaining = Math.max(0, 512 - prefix.byteLength);
          if (remaining > 0) {
            const additional = chunk.subarray(0, remaining);
            const joined = new Uint8Array(prefix.byteLength + additional.byteLength);
            joined.set(prefix);
            joined.set(additional, prefix.byteLength);
            prefix = joined;
          }
          if (prefix.byteLength >= 512) {
            if (!mediaPrefixMatches(mimeType, prefix)) {
              throw new ValidationError('File contents do not match the declared media type.', {
                field: 'mimeType',
              });
            }
            signatureChecked = true;
            for (const buffered of pending) controller.enqueue(buffered);
            pending = [];
          }
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (!signatureChecked && !mediaPrefixMatches(mimeType, prefix)) {
          throw new ValidationError('File contents do not match the declared media type.', {
            field: 'mimeType',
          });
        }
        for (const buffered of pending) controller.enqueue(buffered);
        pending = [];
        if (observedBytes !== expectedBytes) {
          throw new ValidationError('Upload part size does not match its expected size.', {
            field: 'Content-Length',
          });
        }
      },
    }),
  );

  return { stream, getObservedBytes: () => observedBytes };
}

export class ResumableUploadService {
  constructor(
    private readonly dependencies: {
      repository: UploadSessionRepository;
      content: ContentStore;
      files: {
        headObject?(bucket: string, objectKey: string): Promise<{
          sizeBytes: number | null;
        } | null>;
        ensureBucket?(bucket: string): Promise<void>;
      };
      multipart: MultipartFileStorage;
      config: ResumableUploadConfig;
    },
  ) {
    const { partSizeBytes } = dependencies.config;
    if (
      !Number.isInteger(partSizeBytes) ||
      partSizeBytes < 8 * 1024 * 1024 ||
      partSizeBytes > 16 * 1024 * 1024
    ) {
      throw new Error('content_studio_upload_part_size_invalid');
    }
  }

  async create(input: CreateResumableUploadInput) {
    if (!this.dependencies.config.enabled) {
      throw new ServiceUnavailableError(
        'RESUMABLE_UPLOADS_DISABLED',
        'Resumable uploads are not enabled.',
      );
    }
    const { config } = this.dependencies;
    if (!RESUMABLE_MEDIA_TYPES.has(input.mimeType)) {
      throw new ValidationError('This media type is not supported for resumable uploads.', {
        field: 'mimeType',
      });
    }
    if (
      !Number.isSafeInteger(input.expectedSizeBytes) ||
      input.expectedSizeBytes < 1 ||
      input.expectedSizeBytes > config.maxFileBytes
    ) {
      throw new PayloadTooLargeError('File size is invalid or exceeds the Content Studio upload limit.');
    }
    const expectedPartCount = Math.ceil(input.expectedSizeBytes / config.partSizeBytes);
    if (expectedPartCount > MAX_PARTS) {
      throw new PayloadTooLargeError('Upload requires too many parts.');
    }
    const sessionId = randomUUID();
    const objectKey = input.target.type === 'schedule_asset'
      ? contentScheduleObjectKey({
          organizationId: input.organizationId,
          scheduleId: input.target.scheduleId,
          fileId: sessionId,
          filename: input.originalFilename,
        })
      : contentClientObjectKey({
          organizationId: input.organizationId,
          clientId: input.target.clientId,
          fileId: sessionId,
          filename: input.originalFilename,
        });
    const sessionInput: CreateUploadSession = {
      id: sessionId,
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      target: input.target,
      bucket: CONTENT_REVIEW_ASSETS_BUCKET,
      objectKey,
      providerUploadId: null,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      expectedSizeBytes: input.expectedSizeBytes,
      partSizeBytes: config.partSizeBytes,
      expectedPartCount,
      mediaRecordId: randomUUID(),
      assetRecordId: input.target.type === 'schedule_asset' ? randomUUID() : null,
      expiresAt: new Date(Date.now() + config.sessionInactivityMs),
    };
    const session = await this.dependencies.repository.create(sessionInput, {
      maxActivePerUser: config.maxActiveSessionsPerUser,
      maxActivePerOrganization: config.maxActiveSessionsPerOrganization,
      maxReservedBytesPerUser: config.maxReservedBytesPerUser,
      maxReservedBytesPerOrganization: config.maxReservedBytesPerOrganization,
    });

    try {
      await this.dependencies.files.ensureBucket?.(session.bucket);
      const providerUploadId = await this.dependencies.multipart.initiateMultipartUpload(
        session.bucket,
        session.objectKey,
        session.mimeType,
      );
      await this.dependencies.repository.attachProviderUpload(session.id, providerUploadId);
    } catch (error) {
      logger.error(
        { sessionId: session.id, err: error },
        'content_studio_upload_initiation_uncertain',
      );
      try {
        const providerUploadId = await this.dependencies.multipart.findMultipartUpload?.(
          session.bucket,
          session.objectKey,
        );
        if (providerUploadId) {
          await this.dependencies.repository.attachProviderUpload(session.id, providerUploadId);
        } else {
          return publicUploadSession(session, []);
        }
      } catch (recoveryError) {
        logger.error(
          { sessionId: session.id, err: recoveryError },
          'content_studio_upload_initiation_recovery_deferred',
        );
        return publicUploadSession(session, []);
      }
    }
    return this.get(input.organizationId, input.createdBy, session.id);
  }

  async get(organizationId: string, createdBy: string, sessionId: string) {
    const session = await this.requireOwned(organizationId, createdBy, sessionId);
    let parts: MultipartPart[];
    if (session.state === 'completed' || !session.providerUploadId) {
      parts = await this.dependencies.repository.listParts(session.id);
    } else if (session.state === 'uploading') {
      parts = await this.listAndReconcile(session);
    } else {
      parts = await this.dependencies.repository.listParts(session.id);
    }
    return publicUploadSession(session, parts);
  }

  async uploadPart(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    partNumber: number,
    contentLength: number,
    body: ReadableStream<Uint8Array>,
  ) {
    const session = await this.requireOwned(organizationId, createdBy, sessionId);
    if (session.state !== 'uploading' || !session.providerUploadId) {
      throw new ConflictError('UPLOAD_SESSION_NOT_ACTIVE');
    }
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.expectedPartCount
    ) {
      throw new ValidationError('partNumber is outside the session part range.', {
        field: 'partNumber',
      });
    }
    const expectedBytes = Math.min(
      session.partSizeBytes,
      session.expectedSizeBytes - (partNumber - 1) * session.partSizeBytes,
    );
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength !== expectedBytes ||
      (partNumber !== session.expectedPartCount && contentLength < MIN_PART_BYTES)
    ) {
      throw new ValidationError('Content-Length does not match the expected part size.', {
        field: 'Content-Length',
      });
    }
    const claimToken = randomUUID();
    const claim = await this.dependencies.repository.claimPart(
      organizationId,
      createdBy,
      sessionId,
      partNumber,
      claimToken,
      new Date(Date.now() + PART_LEASE_MS),
      {
        maxPerSession: this.dependencies.config.maxConcurrentPartsPerSession,
        maxPerUser: this.dependencies.config.maxConcurrentPartsPerUser,
        maxPerOrganization: this.dependencies.config.maxConcurrentPartsPerOrganization,
        inactivityMs: this.dependencies.config.sessionInactivityMs,
      },
    );
    const validated = validateStream(
      body,
      expectedBytes,
      session.mimeType,
      partNumber === 1,
    );
    try {
      const result = await this.dependencies.multipart.putMultipartPartStream({
        bucket: session.bucket,
        objectKey: session.objectKey,
        uploadId: session.providerUploadId,
        partNumber,
        body: validated.stream,
        contentLength: expectedBytes,
      });
      if (validated.getObservedBytes() !== expectedBytes) {
        throw new ValidationError('Upload part size does not match its expected size.');
      }
      await this.dependencies.repository.commitPart(
        session.id,
        partNumber,
        claim.token,
        { partNumber, sizeBytes: expectedBytes, etag: result.etag },
        new Date(Date.now() + this.dependencies.config.sessionInactivityMs),
      );
      return { partNumber, sizeBytes: expectedBytes };
    } catch (error) {
      await this.dependencies.repository.releasePart(session.id, partNumber, claim.token);
      throw error;
    }
  }

  async complete(organizationId: string, createdBy: string, sessionId: string) {
    await this.requireOwned(organizationId, createdBy, sessionId);
    const claimToken = randomUUID();
    const session = await this.dependencies.repository.claimCompletion(
      organizationId,
      createdBy,
      sessionId,
      claimToken,
      new Date(Date.now() + COMPLETION_LEASE_MS),
    );
    if (session.state === 'completed') {
      return {
        session: publicUploadSession(
          session,
          await this.dependencies.repository.listParts(session.id),
        ),
        result: session.completionResult,
      };
    }
    try {
      const objectHead = await this.dependencies.files.headObject?.(
        session.bucket,
        session.objectKey,
      );
      if (
        objectHead &&
        objectHead.sizeBytes !== null &&
        objectHead.sizeBytes !== session.expectedSizeBytes
      ) {
        throw new ConflictError('UPLOAD_OBJECT_SIZE_MISMATCH');
      }
      if (!objectHead) {
        if (!session.providerUploadId) {
          throw new ConflictError('UPLOAD_PROVIDER_SESSION_MISSING');
        }
        const parts = await this.listAndReconcile(session);
        this.validateCompletionParts(session, parts);
        await this.dependencies.multipart.completeMultipartUpload(
          session.bucket,
          session.objectKey,
          session.providerUploadId,
          parts,
        );
      }
      const verified = await this.dependencies.files.headObject?.(
        session.bucket,
        session.objectKey,
      );
      if (!verified || verified.sizeBytes !== session.expectedSizeBytes) {
        throw new ServiceUnavailableError(
          'UPLOAD_COMPLETION_UNVERIFIED',
          'Completed media could not be verified in storage.',
        );
      }

      const result = await this.finalizeMetadata(session);
      const completed = await this.dependencies.repository.markCompleted(
        session.id,
        claimToken,
        result,
      );
      return {
        session: publicUploadSession(
          completed,
          await this.dependencies.repository.listParts(session.id),
        ),
        result,
      };
    } catch (error) {
      await this.dependencies.repository.releaseCompletion(session.id, claimToken);
      throw error;
    }
  }

  async cancel(organizationId: string, createdBy: string, sessionId: string) {
    const claimToken = randomUUID();
    const session = await this.dependencies.repository.claimCancellation(
      organizationId,
      createdBy,
      sessionId,
      claimToken,
      new Date(Date.now() + COMPLETION_LEASE_MS),
    );
    if (session.state === 'aborted') return { sessionId, state: 'aborted' as const };
    try {
      const objectHead = await this.dependencies.files.headObject?.(
        session.bucket,
        session.objectKey,
      );
      if (objectHead) {
        throw new ConflictError('UPLOAD_OBJECT_ALREADY_COMMITTED');
      }
      if (session.providerUploadId) {
        await this.dependencies.multipart.abortMultipartUpload(
          session.bucket,
          session.objectKey,
          session.providerUploadId,
        );
      } else {
        const orphanedUpload = await this.dependencies.multipart.findMultipartUpload?.(
          session.bucket,
          session.objectKey,
        );
        if (orphanedUpload) {
          await this.dependencies.multipart.abortMultipartUpload(
            session.bucket,
            session.objectKey,
            orphanedUpload,
          );
        }
      }
      await this.dependencies.repository.markCancelled(session.id, claimToken);
      return { sessionId, state: 'aborted' as const };
    } catch (error) {
      await this.dependencies.repository.releaseCancellation(session.id, claimToken);
      throw error;
    }
  }

  async recoverInitiations(limit = 20) {
    const sessions = await this.dependencies.repository.claimRecoverableInitiations(limit);
    let recovered = 0;
    let failures = 0;
    for (const session of sessions) {
      const claimToken = session.completionOwner;
      if (!claimToken) {
        failures += 1;
        logger.error({ sessionId: session.id }, 'content_studio_upload_recovery_claim_missing');
        continue;
      }
      try {
        await this.dependencies.files.ensureBucket?.(session.bucket);
        const providerUploadId =
          await this.dependencies.multipart.findMultipartUpload?.(
            session.bucket,
            session.objectKey,
          );
        const uploadId =
          providerUploadId ??
          (await this.dependencies.multipart.initiateMultipartUpload(
            session.bucket,
            session.objectKey,
            session.mimeType,
          ));
        await this.dependencies.repository.completeInitiationRecovery(
          session.id,
          claimToken,
          uploadId,
        );
        recovered += 1;
      } catch (error) {
        failures += 1;
        await this.dependencies.repository.releaseInitiationRecovery(
          session.id,
          claimToken,
        );
        logger.error(
          { sessionId: session.id, err: error },
          'content_studio_upload_initiation_recovery_failed',
        );
      }
    }
    return { recovered, failures };
  }

  async cleanupExpired(limit = 20) {
    const sessions = await this.dependencies.repository.claimExpired(limit);
    let expired = 0;
    let completed = 0;
    let failures = 0;
    for (const session of sessions) {
      try {
        const objectHead = await this.dependencies.files.headObject?.(
          session.bucket,
          session.objectKey,
        );
        if (objectHead) {
          if (objectHead.sizeBytes !== session.expectedSizeBytes) {
            throw new ConflictError('UPLOAD_OBJECT_SIZE_MISMATCH');
          }
          if (!session.completionOwner) {
            throw new Error('upload_recovery_claim_missing');
          }
          const result = await this.finalizeMetadata(session);
          await this.dependencies.repository.markRecoveredCompleted(
            session.id,
            session.completionOwner,
            result,
          );
          completed += 1;
          continue;
        }
        if (session.providerUploadId) {
          await this.dependencies.multipart.abortMultipartUpload(
            session.bucket,
            session.objectKey,
            session.providerUploadId,
          );
        } else {
          const orphanedUpload = await this.dependencies.multipart.findMultipartUpload?.(
            session.bucket,
            session.objectKey,
          );
          if (orphanedUpload) {
            await this.dependencies.multipart.abortMultipartUpload(
              session.bucket,
              session.objectKey,
              orphanedUpload,
            );
          }
        }
        if (!session.completionOwner) {
          throw new Error('upload_expiry_claim_missing');
        }
        await this.dependencies.repository.markExpired(
          session.id,
          session.completionOwner,
        );
        expired += 1;
      } catch (error) {
        failures += 1;
        logger.error(
          { sessionId: session.id, err: error },
          'content_studio_upload_cleanup_failed',
        );
      }
    }
    return { expired, completed, failures };
  }

  async recoverCompletions(limit = 20) {
    const sessions = await this.dependencies.repository.claimStaleCompletions(limit);
    let completed = 0;
    let released = 0;
    let failures = 0;
    for (const session of sessions) {
      const claimToken = session.completionOwner;
      if (!claimToken) {
        failures += 1;
        logger.error({ sessionId: session.id }, 'content_studio_completion_claim_missing');
        continue;
      }
      try {
        const objectHead = await this.dependencies.files.headObject?.(
          session.bucket,
          session.objectKey,
        );
        if (objectHead) {
          if (objectHead.sizeBytes !== session.expectedSizeBytes) {
            throw new ConflictError('UPLOAD_OBJECT_SIZE_MISMATCH');
          }
          const result = await this.finalizeMetadata(session);
          await this.dependencies.repository.markCompleted(
            session.id,
            claimToken,
            result,
          );
          completed += 1;
        } else {
          await this.dependencies.repository.releaseStaleCompletion(
            session.id,
            claimToken,
          );
          released += 1;
        }
      } catch (error) {
        failures += 1;
        logger.error(
          { sessionId: session.id, err: error },
          'content_studio_completion_recovery_failed',
        );
      }
    }
    return { completed, released, failures };
  }

  async purgeTerminalSessions(limit = 100) {
    return this.dependencies.repository.purgeTerminal(
      this.dependencies.config.terminalRetentionMs,
      limit,
    );
  }

  private async requireOwned(
    organizationId: string,
    createdBy: string,
    sessionId: string,
  ) {
    const session = await this.dependencies.repository.getOwned(
      organizationId,
      createdBy,
      sessionId,
    );
    if (!session) throw new NotFoundError('UPLOAD_SESSION_NOT_FOUND');
    if (
      !['completed', 'aborted', 'expired', 'failed'].includes(session.state) &&
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw new ConflictError('UPLOAD_SESSION_EXPIRED');
    }
    return session;
  }

  private async listAndReconcile(session: UploadSession) {
    if (!session.providerUploadId) return [];
    const parts = await this.dependencies.multipart.listMultipartParts(
      session.bucket,
      session.objectKey,
      session.providerUploadId,
    );
    const ordered = parts.sort((a, b) => a.partNumber - b.partNumber);
    await this.dependencies.repository.reconcileParts(session.id, ordered);
    return ordered;
  }

  private validateCompletionParts(session: UploadSession, parts: MultipartPart[]) {
    if (parts.length !== session.expectedPartCount) {
      throw new ConflictError('UPLOAD_PARTS_INCOMPLETE');
    }
    let totalBytes = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const expectedPartNumber = index + 1;
      const expectedSize = Math.min(
        session.partSizeBytes,
        session.expectedSizeBytes - index * session.partSizeBytes,
      );
      if (
        part.partNumber !== expectedPartNumber ||
        part.sizeBytes !== expectedSize ||
        !part.etag
      ) {
        throw new ConflictError('UPLOAD_PART_MANIFEST_INVALID');
      }
      totalBytes += part.sizeBytes;
    }
    if (totalBytes !== session.expectedSizeBytes) {
      throw new ConflictError('UPLOAD_TOTAL_SIZE_MISMATCH');
    }
  }

  private async finalizeMetadata(session: UploadSession) {
    const common = {
      organizationId: session.organizationId,
      officeId: session.target.officeId,
      uploadedBy: session.createdBy,
      fileName: session.originalFilename,
      fileUrl: `/api/content-studio/media?objectKey=${encodeURIComponent(session.objectKey)}`,
      storagePath: session.objectKey,
      bucket: session.bucket,
      mimeType: session.mimeType,
      assetType: contentAssetTypeFromMime(session.mimeType),
      originalSizeBytes: session.expectedSizeBytes,
      storedSizeBytes: session.expectedSizeBytes,
      compressionStatus: 'stored_original',
      webPlaybackStatus: null,
      expiresAt: CONTENT_ASSET_KEEP_UNTIL,
    };
    if (session.target.type === 'client_media') {
      const media = await this.dependencies.content.finalizeResumableClientMedia({
        ...common,
        id: session.mediaRecordId,
        clientId: session.target.clientId,
        label: session.target.label,
      });
      return { media };
    }
    if (!session.assetRecordId) throw new Error('upload_asset_record_id_missing');
    const asset = await this.dependencies.content.finalizeResumableScheduleAsset(
      {
        ...common,
        id: session.assetRecordId,
        scheduleId: session.target.scheduleId,
        libraryMediaId: null,
        heading: session.target.heading,
        caption: session.target.caption,
        displaySlot: session.target.displaySlot,
        sortOrder: session.target.displaySlot,
        isSelected: true,
      },
      session.target.clientId,
      session.mediaRecordId,
    );
    return { asset };
  }
}
