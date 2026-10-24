import type { MultipartPart } from '../../files/storage.js';

export type UploadTarget =
  | {
      type: 'schedule_asset';
      scheduleId: string;
      clientId: string | null;
      officeId: string;
      displaySlot: number;
      heading: string | null;
      caption: string | null;
    }
  | {
      type: 'client_media';
      clientId: string;
      officeId: string;
      label: string | null;
    };

export type UploadState =
  | 'initiating'
  | 'uploading'
  | 'completing'
  | 'completed'
  | 'aborting'
  | 'aborted'
  | 'expired'
  | 'failed';

export type UploadSession = {
  id: string;
  organizationId: string;
  createdBy: string;
  target: UploadTarget;
  bucket: string;
  objectKey: string;
  providerUploadId: string | null;
  originalFilename: string;
  mimeType: string;
  expectedSizeBytes: number;
  partSizeBytes: number;
  expectedPartCount: number;
  mediaRecordId: string;
  assetRecordId: string | null;
  state: UploadState;
  completionOwner: string | null;
  completionLeaseUntil: Date | null;
  completionResult: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
};

export type CreateUploadSession = Omit<
  UploadSession,
  | 'state'
  | 'completionOwner'
  | 'completionLeaseUntil'
  | 'completionResult'
  | 'createdAt'
  | 'updatedAt'
  | 'completedAt'
  | 'cancelledAt'
>;

export type UploadPartClaim = {
  session: UploadSession;
  token: string;
};

export interface UploadSessionRepository {
  create(
    input: CreateUploadSession,
    limits: {
      maxActivePerUser: number;
      maxActivePerOrganization: number;
      maxReservedBytesPerUser: number;
      maxReservedBytesPerOrganization: number;
    },
  ): Promise<UploadSession>;
  attachProviderUpload(sessionId: string, providerUploadId: string): Promise<void>;
  failInitiation(sessionId: string): Promise<void>;
  getOwned(
    organizationId: string,
    createdBy: string,
    sessionId: string,
  ): Promise<UploadSession | null>;
  claimPart(
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
  ): Promise<UploadPartClaim>;
  commitPart(
    sessionId: string,
    partNumber: number,
    claimToken: string,
    part: MultipartPart,
    expiresAt: Date,
  ): Promise<void>;
  releasePart(sessionId: string, partNumber: number, claimToken: string): Promise<void>;
  reconcileParts(sessionId: string, parts: MultipartPart[]): Promise<void>;
  listParts(sessionId: string): Promise<MultipartPart[]>;
  claimCompletion(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    claimToken: string,
    leaseUntil: Date,
  ): Promise<UploadSession>;
  releaseCompletion(sessionId: string, claimToken: string): Promise<void>;
  releaseCancellation(sessionId: string, claimToken: string): Promise<void>;
  markCompleted(
    sessionId: string,
    claimToken: string,
    result: Record<string, unknown>,
  ): Promise<UploadSession>;
  markRecoveredCompleted(
    sessionId: string,
    claimToken: string,
    result: Record<string, unknown>,
  ): Promise<void>;
  claimStaleCompletions(limit: number): Promise<UploadSession[]>;
  releaseStaleCompletion(sessionId: string, claimToken: string): Promise<void>;
  claimCancellation(
    organizationId: string,
    createdBy: string,
    sessionId: string,
    claimToken: string,
    leaseUntil: Date,
  ): Promise<UploadSession>;
  markCancelled(sessionId: string, claimToken: string): Promise<void>;
  claimExpired(limit: number): Promise<UploadSession[]>;
  markExpired(sessionId: string, claimToken: string): Promise<void>;
  claimRecoverableInitiations(limit: number): Promise<UploadSession[]>;
  completeInitiationRecovery(
    sessionId: string,
    claimToken: string,
    providerUploadId: string,
  ): Promise<void>;
  releaseInitiationRecovery(sessionId: string, claimToken: string): Promise<void>;
  purgeTerminal(retentionMs: number, limit: number): Promise<number>;
}

export type PublicUploadSession = {
  sessionId: string;
  state: UploadState;
  targetType: UploadTarget['type'];
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  partSizeBytes: number;
  partCount: number;
  expiresAt: string;
  committedParts: Array<Pick<MultipartPart, 'partNumber' | 'sizeBytes'>>;
  result?: Record<string, unknown>;
};
