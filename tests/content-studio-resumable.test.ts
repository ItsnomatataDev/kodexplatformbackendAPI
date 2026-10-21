import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from '../src/http/errors.js';
import type { ContentClientMediaRecord, ContentScheduleAssetRecord, ContentStore } from '../src/content/store.js';
import { ResumableUploadService, type ResumableUploadConfig } from '../src/content/resumable/service.js';
import { createResumableUploadRoutes } from '../src/content/resumable/routes.js';
import type {
  CreateUploadSession,
  UploadPartClaim,
  UploadSession,
  UploadSessionRepository,
  UploadState,
} from '../src/content/resumable/types.js';
import type { MultipartFileStorage, MultipartPart } from '../src/files/storage.js';
import { bodyLimitMiddleware } from '../src/middleware/body-limit.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { MemoryRateLimiter } from '../src/auth/rate-limit.js';
import { authContext, orgA, orgB, userA } from './work-harness.js';

const PART_BYTES = 8 * 1024 * 1024;
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const SCHEDULE_ID = '00000000-0000-4000-8000-000000000003';
const OFFICE_ID = '00000000-0000-4000-8000-000000000004';

const config: ResumableUploadConfig = {
  enabled: true,
  maxFileBytes: 1024 * 1024 * 1024,
  partSizeBytes: PART_BYTES,
  sessionInactivityMs: 7 * 24 * 60 * 60 * 1000,
  terminalRetentionMs: 30 * 24 * 60 * 60 * 1000,
  maxActiveSessionsPerUser: 2,
  maxActiveSessionsPerOrganization: 8,
  maxReservedBytesPerUser: 2 * 1024 * 1024 * 1024,
  maxReservedBytesPerOrganization: 10 * 1024 * 1024 * 1024,
  maxConcurrentPartsPerSession: 2,
  maxConcurrentPartsPerUser: 4,
  maxConcurrentPartsPerOrganization: 16,
};

class FakeUploadRepository implements UploadSessionRepository {
  readonly sessions = new Map<string, UploadSession>();
  readonly parts = new Map<string, Map<number, MultipartPart>>();
  private readonly partClaims = new Map<string, string>();
  failMarkCompletedOnce = false;

  async create(input: CreateUploadSession) {
    const session: UploadSession = {
      ...input,
      state: 'initiating',
      completionOwner: null,
      completionLeaseUntil: null,
      completionResult: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      cancelledAt: null,
    };
    this.sessions.set(session.id, session);
    this.parts.set(session.id, new Map());
    return session;
  }

  async attachProviderUpload(sessionId: string, providerUploadId: string) {
    const session = this.sessions.get(sessionId)!;
    session.providerUploadId = providerUploadId;
    session.state = 'uploading';
  }

  async failInitiation(sessionId: string) {
    this.sessions.get(sessionId)!.state = 'failed';
  }

  async getOwned(organizationId: string, createdBy: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session?.organizationId === organizationId && session.createdBy === createdBy
      ? session
      : null;
  }

  async claimPart(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    partNumber: number,
    claimToken: string,
    _leaseUntil: Date,
  ): Promise<UploadPartClaim> {
    const session = await this.getOwned(organizationId, createdBy, sessionId);
    if (!session) throw new NotFoundError('UPLOAD_SESSION_NOT_FOUND');
    if (session.state !== 'uploading') throw new ConflictError('UPLOAD_SESSION_NOT_ACTIVE');
    const key = `${sessionId}:${partNumber}`;
    if (this.partClaims.has(key)) throw new ConflictError('UPLOAD_PART_IN_PROGRESS');
    this.partClaims.set(key, claimToken);
    return { session, token: claimToken };
  }

  async commitPart(
    sessionId: string,
    partNumber: number,
    claimToken: string,
    part: MultipartPart,
    expiresAt: Date,
  ) {
    const key = `${sessionId}:${partNumber}`;
    if (this.partClaims.get(key) !== claimToken) throw new ConflictError('UPLOAD_PART_CLAIM_LOST');
    this.parts.get(sessionId)!.set(partNumber, part);
    this.partClaims.delete(key);
    this.sessions.get(sessionId)!.expiresAt = expiresAt;
  }

  async releasePart(sessionId: string, partNumber: number, claimToken: string) {
    const key = `${sessionId}:${partNumber}`;
    if (this.partClaims.get(key) === claimToken) this.partClaims.delete(key);
  }

  async reconcileParts(sessionId: string, parts: MultipartPart[]) {
    this.parts.set(sessionId, new Map(parts.map((part) => [part.partNumber, part])));
  }

  async listParts(sessionId: string) {
    return [...(this.parts.get(sessionId)?.values() ?? [])].sort(
      (left, right) => left.partNumber - right.partNumber,
    );
  }

  async claimCompletion(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    claimToken: string,
    leaseUntil: Date,
  ) {
    const session = await this.getOwned(organizationId, createdBy, sessionId);
    if (!session) throw new NotFoundError('UPLOAD_SESSION_NOT_FOUND');
    if (session.state === 'completed') return session;
    if (session.state !== 'uploading') throw new ConflictError('UPLOAD_COMPLETION_IN_PROGRESS');
    session.state = 'completing';
    session.completionOwner = claimToken;
    session.completionLeaseUntil = leaseUntil;
    return session;
  }

  async releaseCompletion(sessionId: string, claimToken: string) {
    const session = this.sessions.get(sessionId)!;
    if (session.state === 'completing' && session.completionOwner === claimToken) {
      session.state = 'uploading';
      session.completionOwner = null;
      session.completionLeaseUntil = null;
    }
  }

  async releaseCancellation(sessionId: string, claimToken: string) {
    const session = this.sessions.get(sessionId)!;
    if (session.state === 'aborting' && session.completionOwner === claimToken) {
      session.state = 'uploading';
      session.completionOwner = null;
      session.completionLeaseUntil = null;
    }
  }

  async markCompleted(sessionId: string, claimToken: string, result: Record<string, unknown>) {
    if (this.failMarkCompletedOnce) {
      this.failMarkCompletedOnce = false;
      throw new Error('database_acknowledgement_lost');
    }
    const session = this.sessions.get(sessionId)!;
    if (session.state === 'completed') return session;
    if (session.completionOwner !== claimToken) throw new ConflictError('UPLOAD_COMPLETION_CLAIM_LOST');
    session.state = 'completed';
    session.completionResult = result;
    session.completionOwner = null;
    session.completionLeaseUntil = null;
    session.completedAt = new Date();
    return session;
  }

  async markRecoveredCompleted(
    sessionId: string,
    claimToken: string,
    result: Record<string, unknown>,
  ) {
    const session = this.sessions.get(sessionId)!;
    if (session.completionOwner !== claimToken) throw new ConflictError('UPLOAD_RECOVERY_CLAIM_LOST');
    session.state = 'completed';
    session.completionResult = result;
    session.completionOwner = null;
    session.completionLeaseUntil = null;
  }

  async claimStaleCompletions() {
    const stale: UploadSession[] = [];
    for (const session of this.sessions.values()) {
      if (
        session.state === 'completing' &&
        session.completionLeaseUntil &&
        session.completionLeaseUntil.getTime() <= Date.now() &&
        session.expiresAt.getTime() > Date.now()
      ) {
        session.completionOwner = `recovery-${session.id}`;
        session.completionLeaseUntil = new Date(Date.now() + 40 * 60_000);
        stale.push(session);
      }
    }
    return stale;
  }

  async releaseStaleCompletion(sessionId: string, claimToken: string) {
    const session = this.sessions.get(sessionId)!;
    if (session.state === 'completing' && session.completionOwner === claimToken) {
      session.state = 'uploading';
      session.completionOwner = null;
      session.completionLeaseUntil = null;
    }
  }

  async claimCancellation(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    claimToken: string,
    leaseUntil: Date,
  ) {
    const session = await this.getOwned(organizationId, createdBy, sessionId);
    if (!session) throw new NotFoundError('UPLOAD_SESSION_NOT_FOUND');
    if (session.state === 'aborted') return session;
    if (session.state !== 'uploading' && session.state !== 'initiating') {
      throw new ConflictError('UPLOAD_SESSION_BUSY');
    }
    session.state = 'aborting';
    session.completionOwner = claimToken;
    session.completionLeaseUntil = leaseUntil;
    return session;
  }

  async markCancelled(sessionId: string, claimToken: string) {
    const session = this.sessions.get(sessionId)!;
    if (session.completionOwner !== claimToken) throw new ConflictError('UPLOAD_CANCELLATION_CLAIM_LOST');
    session.state = 'aborted';
    session.cancelledAt = new Date();
    session.completionOwner = null;
  }

  async claimExpired() {
    const expired: UploadSession[] = [];
    for (const session of this.sessions.values()) {
      if (
        session.expiresAt.getTime() <= Date.now() &&
        ['initiating', 'uploading', 'completing'].includes(session.state)
      ) {
        session.state = 'aborting';
        session.completionOwner = 'cleanup-owner';
        expired.push(session);
      }
    }
    return expired;
  }

  async markExpired(sessionId: string, claimToken: string) {
    const session = this.sessions.get(sessionId)!;
    if (session.completionOwner !== claimToken) throw new ConflictError('UPLOAD_EXPIRY_CLAIM_LOST');
    session.state = 'expired';
  }

  async claimRecoverableInitiations() {
    const stale: UploadSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.state === 'initiating') {
        session.state = 'completing';
        session.completionOwner = `init-recovery-${session.id}`;
        session.completionLeaseUntil = new Date(Date.now() + 5 * 60_000);
        stale.push(session);
      }
    }
    return stale;
  }

  async completeInitiationRecovery(
    sessionId: string,
    claimToken: string,
    providerUploadId: string,
  ) {
    const session = this.sessions.get(sessionId)!;
    if (session.completionOwner !== claimToken) throw new ConflictError('UPLOAD_RECOVERY_CLAIM_LOST');
    session.state = 'uploading';
    session.providerUploadId = providerUploadId;
    session.completionOwner = null;
    session.completionLeaseUntil = null;
  }

  async releaseInitiationRecovery(sessionId: string, claimToken: string) {
    const session = this.sessions.get(sessionId)!;
    if (session.completionOwner === claimToken) {
      session.state = 'initiating';
      session.completionOwner = null;
      session.completionLeaseUntil = null;
    }
  }

  async purgeTerminal() {
    return 0;
  }
}

class FakeMultipartStorage implements MultipartFileStorage {
  readonly parts = new Map<number, MultipartPart>();
  initiateCount = 0;
  completeCount = 0;
  abortCount = 0;
  failCompletionAfterCommit = false;
  failInitiationOnce = false;
  objectSize: number | null = null;
  maxObservedChunkBytes = 0;
  totalStreamedBytes = 0;
  private activeUploadId: string | null = null;

  async initiateMultipartUpload() {
    this.initiateCount += 1;
    if (this.failInitiationOnce) {
      this.failInitiationOnce = false;
      throw new Error('provider_ack_lost');
    }
    this.activeUploadId = `provider-${this.initiateCount}`;
    return this.activeUploadId;
  }

  async putMultipartPartStream(input: {
    partNumber: number;
    body: ReadableStream<Uint8Array>;
    contentLength: number;
  }) {
    const reader = input.body.getReader();
    let sizeBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sizeBytes += value.byteLength;
      this.totalStreamedBytes += value.byteLength;
      this.maxObservedChunkBytes = Math.max(this.maxObservedChunkBytes, value.byteLength);
    }
    this.parts.set(input.partNumber, {
      partNumber: input.partNumber,
      sizeBytes,
      etag: `etag-${input.partNumber}-${sizeBytes}`,
    });
    return { etag: `etag-${input.partNumber}-${sizeBytes}` };
  }

  async listMultipartParts() {
    return [...this.parts.values()].sort((left, right) => left.partNumber - right.partNumber);
  }

  async completeMultipartUpload() {
    this.completeCount += 1;
    this.objectSize = [...this.parts.values()].reduce((total, part) => total + part.sizeBytes, 0);
    this.activeUploadId = null;
    if (this.failCompletionAfterCommit) {
      this.failCompletionAfterCommit = false;
      throw new Error('provider_ack_lost');
    }
  }

  async abortMultipartUpload() {
    this.abortCount += 1;
    this.activeUploadId = null;
  }

  async findMultipartUpload() {
    return this.activeUploadId;
  }
}

function fakeContent(options: { failFinalizationOnce?: boolean } = {}) {
  let mediaCount = 0;
  let assetCount = 0;
  let failFinalization = options.failFinalizationOnce ?? false;
  const mediaRows = new Map<string, ContentClientMediaRecord>();
  const assetRows = new Map<string, ContentScheduleAssetRecord>();
  const content = {
    async finalizeResumableClientMedia(input: {
      id: string;
      clientId: string;
      organizationId: string;
      officeId: string;
      uploadedBy: string;
      fileName: string;
      fileUrl: string;
      storagePath: string;
      bucket: string;
      mimeType?: string | null;
      assetType: string;
      label?: string | null;
      originalSizeBytes?: number | null;
      storedSizeBytes?: number | null;
      compressionStatus?: string;
      webPlaybackStatus?: string | null;
      expiresAt?: Date | null;
    }): Promise<ContentClientMediaRecord> {
      if (failFinalization) {
        failFinalization = false;
        throw new Error('database_unavailable');
      }
      const existing = mediaRows.get(input.id);
      if (existing) return existing;
      mediaCount += 1;
      const media: ContentClientMediaRecord = {
        id: input.id,
        clientId: input.clientId,
        organizationId: input.organizationId,
        officeId: input.officeId,
        uploadedBy: input.uploadedBy,
        fileName: input.fileName,
        fileUrl: input.fileUrl,
        storagePath: input.storagePath,
        bucket: input.bucket,
        mimeType: input.mimeType ?? null,
        assetType: input.assetType,
        label: input.label ?? null,
        originalSizeBytes: input.originalSizeBytes ?? null,
        storedSizeBytes: input.storedSizeBytes ?? null,
        compressionStatus: input.compressionStatus ?? 'stored_original',
        webPlaybackStatus: input.webPlaybackStatus ?? null,
        expiresAt: input.expiresAt ?? null,
        createdAt: new Date(),
      };
      mediaRows.set(media.id, media);
      return media;
    },
    async finalizeResumableScheduleAsset(
      input: {
        id: string;
        scheduleId: string;
        organizationId: string;
        officeId: string;
        uploadedBy: string;
        fileName: string;
        fileUrl: string;
        storagePath: string;
        bucket: string;
        mimeType?: string | null;
        assetType: string;
        libraryMediaId?: string | null;
        heading?: string | null;
        caption?: string | null;
        isSelected?: boolean;
        cropX?: number | null;
        cropY?: number | null;
        cropZoom?: number | null;
        sortOrder?: number;
        displaySlot?: number;
        originalSizeBytes?: number | null;
        storedSizeBytes?: number | null;
        compressionStatus?: string;
        webPlaybackStatus?: string | null;
        expiresAt?: Date | null;
      },
      clientId: string | null,
      mediaRecordId: string,
    ): Promise<ContentScheduleAssetRecord> {
      if (failFinalization) {
        failFinalization = false;
        throw new Error('database_unavailable');
      }
      const existing = assetRows.get(input.id);
      if (existing) return existing;
      if (clientId) assert.ok(mediaRecordId);
      if (clientId) mediaCount += 1;
      assetCount += 1;
      const asset: ContentScheduleAssetRecord = {
        id: input.id,
        scheduleId: input.scheduleId,
        organizationId: input.organizationId,
        officeId: input.officeId,
        libraryMediaId: clientId ? mediaRecordId : (input.libraryMediaId ?? null),
        uploadedBy: input.uploadedBy,
        fileName: input.fileName,
        fileUrl: input.fileUrl,
        storagePath: input.storagePath,
        bucket: input.bucket,
        mimeType: input.mimeType ?? null,
        assetType: input.assetType,
        heading: input.heading ?? null,
        caption: input.caption ?? null,
        isSelected: input.isSelected ?? true,
        cropX: input.cropX ?? 50,
        cropY: input.cropY ?? 50,
        cropZoom: input.cropZoom ?? 1,
        sortOrder: input.sortOrder ?? 0,
        displaySlot: input.displaySlot ?? 0,
        originalSizeBytes: input.originalSizeBytes ?? null,
        storedSizeBytes: input.storedSizeBytes ?? null,
        compressionStatus: input.compressionStatus ?? 'stored_original',
        webPlaybackStatus: input.webPlaybackStatus ?? null,
        expiresAt: input.expiresAt ?? null,
        createdAt: new Date(),
      };
      assetRows.set(asset.id, asset);
      return asset;
    },
  } as unknown as ContentStore;
  return {
    content,
    get mediaCount() {
      return mediaCount;
    },
    get assetCount() {
      return assetCount;
    },
  };
}

function newService(options: {
  repository?: FakeUploadRepository;
  multipart?: FakeMultipartStorage;
  enabled?: boolean;
  content?: ReturnType<typeof fakeContent>;
  configOverrides?: Partial<ResumableUploadConfig>;
} = {}) {
  const repository = options.repository ?? new FakeUploadRepository();
  const multipart = options.multipart ?? new FakeMultipartStorage();
  const content = options.content ?? fakeContent();
  const service = new ResumableUploadService({
    repository,
    content: content.content,
    files: {
      async ensureBucket() {},
      async headObject() {
        return multipart.objectSize === null
          ? null
          : { sizeBytes: multipart.objectSize };
      },
    },
    multipart,
    config: { ...config, enabled: options.enabled ?? true, ...options.configOverrides },
  });
  return { service, repository, multipart, content };
}

async function createUpload(
  service: ResumableUploadService,
  size: number,
  overrides: Partial<{
    organizationId: string;
    createdBy: string;
    mimeType: string;
  }> = {},
) {
  return service.create({
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    createdBy: overrides.createdBy ?? USER_ID,
    target: {
      type: 'schedule_asset',
      scheduleId: SCHEDULE_ID,
      clientId: null,
      officeId: OFFICE_ID,
      displaySlot: 0,
      heading: null,
      caption: null,
    },
    originalFilename: 'clip.mp4',
    mimeType: overrides.mimeType ?? 'video/mp4',
    expectedSizeBytes: size,
  });
}

function byteStream(size: number, mimeType: string, chunkSize = 1024 * 1024) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const length = Math.min(chunkSize, size - sent);
      const chunk = new Uint8Array(length);
      if (sent === 0) {
        if (mimeType === 'video/mp4') {
          chunk.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
        } else if (mimeType === 'image/jpeg') {
          chunk.set([0xff, 0xd8, 0xff]);
        }
      }
      sent += length;
      controller.enqueue(chunk);
    },
  });
}

async function sendPart(
  service: ResumableUploadService,
  sessionId: string,
  partNumber: number,
  contentLength: number,
  mimeType = 'video/mp4',
) {
  return service.uploadPart(
    ORGANIZATION_ID,
    USER_ID,
    sessionId,
    partNumber,
    contentLength,
    byteStream(contentLength, mimeType),
  );
}

test('streams a 312 MiB upload as 39 provider parts and finalizes one asset', async () => {
  const { service, multipart, content } = newService();
  const totalSize = 312 * 1024 * 1024;
  const session = await createUpload(service, totalSize);
  for (let partNumber = 1; partNumber <= 39; partNumber += 1) {
    await sendPart(service, session.sessionId, partNumber, PART_BYTES);
  }
  const completed = await service.complete(ORGANIZATION_ID, USER_ID, session.sessionId);
  assert.equal(completed.session.state, 'completed');
  assert.equal(multipart.totalStreamedBytes, totalSize);
  assert.equal(multipart.maxObservedChunkBytes, 1024 * 1024);
  assert.equal(multipart.completeCount, 1);
  assert.equal(content.assetCount, 1);
});

test('validates configured file limits, part sizes, and first-part media signature', async () => {
  const { service } = newService();
  await assert.rejects(
    createUpload(service, config.maxFileBytes + 1),
    PayloadTooLargeError,
  );
  const session = await createUpload(service, PART_BYTES);
  await assert.rejects(
    service.uploadPart(
      ORGANIZATION_ID,
      USER_ID,
      session.sessionId,
      1,
      PART_BYTES - 1,
      byteStream(PART_BYTES - 1, 'video/mp4'),
    ),
    ValidationError,
  );
  await assert.rejects(
    service.uploadPart(
      ORGANIZATION_ID,
      USER_ID,
      session.sessionId,
      1,
      PART_BYTES,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(PART_BYTES));
          controller.close();
        },
      }),
    ),
    ValidationError,
  );
});

test('reconciles committed parts after service recreation and accepts out-of-order retries', async () => {
  const repository = new FakeUploadRepository();
  const multipart = new FakeMultipartStorage();
  const first = newService({ repository, multipart });
  const session = await createUpload(first.service, PART_BYTES + 1024);
  await sendPart(first.service, session.sessionId, 2, 1024);

  const restarted = newService({ repository, multipart });
  const state = await restarted.service.get(ORGANIZATION_ID, USER_ID, session.sessionId);
  assert.deepEqual(state.committedParts, [{ partNumber: 2, sizeBytes: 1024 }]);
  await sendPart(restarted.service, session.sessionId, 1, PART_BYTES);
  await sendPart(restarted.service, session.sessionId, 2, 1024);
  const completed = await restarted.service.complete(
    ORGANIZATION_ID,
    USER_ID,
    session.sessionId,
  );
  assert.equal(completed.session.state, 'completed');
  assert.equal(multipart.completeCount, 1);
});

test('recovers a lost provider completion acknowledgement without duplicate metadata', async () => {
  const { service, multipart, content } = newService();
  const session = await createUpload(service, PART_BYTES);
  await sendPart(service, session.sessionId, 1, PART_BYTES);
  multipart.failCompletionAfterCommit = true;
  await assert.rejects(
    service.complete(ORGANIZATION_ID, USER_ID, session.sessionId),
  );
  const retry = await service.complete(ORGANIZATION_ID, USER_ID, session.sessionId);
  const repeated = await service.complete(ORGANIZATION_ID, USER_ID, session.sessionId);
  assert.equal(retry.session.state, 'completed');
  assert.equal(repeated.session.state, 'completed');
  assert.equal(multipart.completeCount, 1);
  assert.equal(content.assetCount, 1);
});

test('recovers an initiation whose provider acknowledgement was lost', async () => {
  const multipart = new FakeMultipartStorage();
  multipart.failInitiationOnce = true;
  const { service, repository } = newService({ multipart });
  const session = await createUpload(service, PART_BYTES);
  assert.equal(session.state, 'initiating');
  const recovered = await service.recoverInitiations();
  assert.equal(recovered.recovered, 1);
  assert.equal(repository.sessions.get(session.sessionId)?.state, 'uploading');
  assert.equal(multipart.initiateCount, 2);
});

test('maintenance completes an object left committed by a crashed finalizer', async () => {
  const { service, repository, multipart, content } = newService();
  const session = await createUpload(service, PART_BYTES);
  await sendPart(service, session.sessionId, 1, PART_BYTES);
  const row = repository.sessions.get(session.sessionId)!;
  row.state = 'completing';
  row.completionOwner = 'abandoned-completion';
  row.completionLeaseUntil = new Date(0);
  multipart.objectSize = PART_BYTES;
  const recovered = await service.recoverCompletions();
  assert.equal(recovered.completed, 1);
  assert.equal(row.state, 'completed');
  assert.equal(content.assetCount, 1);
});

test('retains completed object after metadata failure and finalizes on retry', async () => {
  const content = fakeContent({ failFinalizationOnce: true });
  const { service, multipart } = newService({ content });
  const session = await createUpload(service, PART_BYTES);
  await sendPart(service, session.sessionId, 1, PART_BYTES);
  await assert.rejects(service.complete(ORGANIZATION_ID, USER_ID, session.sessionId));
  assert.equal(multipart.objectSize, PART_BYTES);
  const completed = await service.complete(ORGANIZATION_ID, USER_ID, session.sessionId);
  assert.equal(completed.session.state, 'completed');
  assert.equal(multipart.abortCount, 0);
  assert.equal(content.assetCount, 1);
});

test('reconciles metadata committed before a lost session-completion acknowledgement', async () => {
  const { service, repository, content } = newService();
  const session = await createUpload(service, PART_BYTES);
  await sendPart(service, session.sessionId, 1, PART_BYTES);
  repository.failMarkCompletedOnce = true;
  await assert.rejects(service.complete(ORGANIZATION_ID, USER_ID, session.sessionId));
  const completed = await service.complete(ORGANIZATION_ID, USER_ID, session.sessionId);
  assert.equal(completed.session.state, 'completed');
  assert.equal(content.assetCount, 1);
});

test('schedule uploads with a client finalize one library row and one schedule asset', async () => {
  const { service, content } = newService();
  const session = await service.create({
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    target: {
      type: 'schedule_asset',
      scheduleId: SCHEDULE_ID,
      clientId: '00000000-0000-4000-8000-000000000005',
      officeId: OFFICE_ID,
      displaySlot: 0,
      heading: null,
      caption: null,
    },
    originalFilename: 'clip.mp4',
    mimeType: 'video/mp4',
    expectedSizeBytes: PART_BYTES,
  });
  await sendPart(service, session.sessionId, 1, PART_BYTES);
  await service.complete(ORGANIZATION_ID, USER_ID, session.sessionId);
  assert.equal(content.mediaCount, 1);
  assert.equal(content.assetCount, 1);
});

test('serializes simultaneous completion and rejects cross-organization or non-owner access', async () => {
  const { service, repository, multipart, content } = newService();
  const session = await createUpload(service, PART_BYTES);
  await sendPart(service, session.sessionId, 1, PART_BYTES);
  await assert.rejects(
    service.get('00000000-0000-4000-8000-000000000099', USER_ID, session.sessionId),
    NotFoundError,
  );
  await assert.rejects(
    service.cancel(ORGANIZATION_ID, '00000000-0000-4000-8000-000000000099', session.sessionId),
    NotFoundError,
  );
  const results = await Promise.allSettled([
    service.complete(ORGANIZATION_ID, USER_ID, session.sessionId),
    service.complete(ORGANIZATION_ID, USER_ID, session.sessionId),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(multipart.completeCount, 1);
  assert.equal(content.assetCount, 1);
  assert.equal(repository.sessions.get(session.sessionId)?.state, 'completed');
});

test('cancels incomplete upload and expires abandoned sessions without deleting objects', async () => {
  const cancelled = newService();
  const cancelledSession = await createUpload(cancelled.service, PART_BYTES);
  const cancellation = await cancelled.service.cancel(
    ORGANIZATION_ID,
    USER_ID,
    cancelledSession.sessionId,
  );
  assert.equal(cancellation.state, 'aborted');
  assert.equal(cancelled.multipart.abortCount, 1);

  const expired = newService();
  const expiredSession = await createUpload(expired.service, PART_BYTES);
  expired.repository.sessions.get(expiredSession.sessionId)!.expiresAt = new Date(0);
  const cleanup = await expired.service.cleanupExpired();
  assert.equal(cleanup.expired, 1);
  assert.equal(expired.repository.sessions.get(expiredSession.sessionId)?.state, 'expired');
  assert.equal(expired.multipart.abortCount, 1);

  const committed = newService();
  const committedSession = await createUpload(committed.service, PART_BYTES);
  await sendPart(committed.service, committedSession.sessionId, 1, PART_BYTES);
  committed.multipart.objectSize = PART_BYTES;
  committed.repository.sessions.get(committedSession.sessionId)!.expiresAt = new Date(0);
  const committedCleanup = await committed.service.cleanupExpired();
  assert.equal(committedCleanup.completed, 1);
  assert.equal(committed.multipart.abortCount, 0);
  assert.equal(committed.repository.sessions.get(committedSession.sessionId)?.state, 'completed');
});

test('does not create new sessions when the feature flag is disabled', async () => {
  const { service, repository } = newService({ enabled: false });
  await assert.rejects(createUpload(service, PART_BYTES));
  assert.equal(repository.sessions.size, 0);
});

test('multipart part path bypasses text buffering but preserves raw request bytes', async () => {
  const app = new Hono();
  app.use('*', bodyLimitMiddleware(1));
  app.put('/api/content-studio/uploads/sessions/:sessionId/parts/:partNumber', async (c) => {
    const bytes = await c.req.arrayBuffer();
    return c.text(String(bytes.byteLength));
  });
  const response = await app.request(
    `/api/content-studio/uploads/sessions/${SCHEDULE_ID}/parts/1`,
    {
      method: 'PUT',
      headers: { 'content-length': '3' },
      body: new Uint8Array([1, 2, 3]),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '3');
});

test('mounted session creation remains disabled until the feature flag is enabled', async () => {
  const { service, repository } = newService({ enabled: false });
  const content = {
    ...fakeContent().content,
    async getSchedule(organizationId: string, scheduleId: string) {
      return organizationId === orgA && scheduleId === SCHEDULE_ID
        ? { id: scheduleId, organizationId, officeId: OFFICE_ID, clientId: null }
        : null;
    },
  } as unknown as ContentStore;
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('auth', authContext({ actor: { userId: userA } }));
    c.set('rateLimiter', new MemoryRateLimiter(['development']));
    c.set('rateLimitPolicies', {
      uploadSession: { limit: 10, windowSeconds: 3600 },
      uploadPart: { limit: 1000, windowSeconds: 60 },
    } as never);
    await next();
  });
  const directory = {
    async getOffice(organizationId: string, officeId: string) {
      return organizationId === orgA && officeId === OFFICE_ID ? { slug: 'test-office' } : null;
    },
  };
  app.route(
    '/api/content-studio/uploads',
    createResumableUploadRoutes({
      service,
      repository,
      content,
      directory: directory as never,
    }),
  );
  const response = await app.request('/api/content-studio/uploads/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scheduleId: SCHEDULE_ID,
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: PART_BYTES,
    }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'RESUMABLE_UPLOADS_DISABLED');
  assert.equal(repository.sessions.size, 0);
});

test('mounted session route hides sessions across organizations before storage access', async () => {
  const { service, repository, multipart } = newService();
  const session = await createUpload(service, PART_BYTES);
  let targetLookups = 0;
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('auth', authContext({
      actor: { userId: userA },
      membership: { organizationId: orgB, isAdminRole: true },
      organization: { organizationId: orgB },
    }));
    await next();
  });
  app.route(
    '/api/content-studio/uploads',
    createResumableUploadRoutes({
      service,
      repository,
      content: {
        async getSchedule() {
          targetLookups += 1;
          return null;
        },
      } as unknown as ContentStore,
      directory: {
        async getOffice() {
          targetLookups += 1;
          return null;
        },
      } as never,
    }),
  );
  const response = await app.request(
    `/api/content-studio/uploads/sessions/${session.sessionId}`,
  );
  assert.equal(response.status, 404);
  assert.equal(targetLookups, 0);
  assert.equal(multipart.parts.size, 0);
});
