export const CONTENT_SCHEDULE_STATUSES = [
  'draft',
  'ready_for_review',
  'sent_to_client',
  'viewed',
  'changes_requested',
  'approved',
  'published',
  'archived',
] as const;

export type ContentScheduleStatus = (typeof CONTENT_SCHEDULE_STATUSES)[number];

export type ContentClientRecord = {
  id: string;
  organizationId: string;
  officeId: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string | null;
  internalReviewerEmail: string | null;
  portalToken: string;
  loginPinHash: string;
  pinLastGeneratedAt: Date;
  pinExpiresAt: Date | null;
  isActive: boolean;
  aiVoiceProfile: Record<string, unknown>;
  aiCaptionExamples: unknown[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ContentScheduleRecord = {
  id: string;
  organizationId: string;
  officeId: string;
  clientId: string | null;
  createdBy: string | null;
  assignedTo: string | null;
  title: string;
  subtitle: string | null;
  body: string | null;
  summary: string | null;
  captions: string | null;
  notes: string | null;
  layoutType: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  reviewToken: string;
  reviewUrl: string | null;
  slug: string | null;
  status: ContentScheduleStatus;
  reviewStatus: string | null;
  scheduledAt: Date | null;
  expiresAt: Date | null;
  approvedAt: Date | null;
  approvedByName: string | null;
  approvedByEmail: string | null;
  changesRequestedAt: Date | null;
  lastViewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ContentClientMediaRecord = {
  id: string;
  clientId: string;
  organizationId: string;
  officeId: string;
  uploadedBy: string | null;
  fileName: string;
  fileUrl: string;
  storagePath: string | null;
  bucket: string;
  mimeType: string | null;
  assetType: string;
  label: string | null;
  originalSizeBytes: number | null;
  storedSizeBytes: number | null;
  compressionStatus: string;
  webPlaybackStatus: string | null;
  expiresAt: Date | null;
  createdAt: Date;
};

export type ContentScheduleAssetRecord = {
  id: string;
  scheduleId: string;
  organizationId: string;
  officeId: string;
  libraryMediaId: string | null;
  uploadedBy: string | null;
  fileName: string;
  fileUrl: string;
  storagePath: string | null;
  bucket: string;
  mimeType: string | null;
  assetType: string;
  heading: string | null;
  caption: string | null;
  isSelected: boolean;
  cropX: number | null;
  cropY: number | null;
  cropZoom: number | null;
  sortOrder: number;
  displaySlot: number;
  originalSizeBytes: number | null;
  storedSizeBytes: number | null;
  compressionStatus: string;
  webPlaybackStatus: string | null;
  expiresAt: Date | null;
  createdAt: Date;
};

export type ContentCommentRecord = {
  id: string;
  scheduleId: string;
  organizationId: string;
  officeId: string;
  parentCommentId: string | null;
  authorName: string;
  authorEmail: string | null;
  body: string;
  source: string;
  visibility: string;
  authorType: string;
  commentType: string;
  displaySlot: number | null;
  createdBy: string | null;
  createdAt: Date;
};

export type ContentActivityRecord = {
  id: string;
  scheduleId: string;
  organizationId: string;
  officeId: string;
  actorUserId: string | null;
  activityType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type CreateClientInput = {
  organizationId: string;
  officeId: string;
  companyName: string;
  contactName: string;
  email: string;
  phone?: string | null;
  internalReviewerEmail?: string | null;
  portalToken: string;
  loginPinHash: string;
  pinExpiresAt?: Date | null;
  createdBy: string;
};

export type UpdateClientInput = {
  companyName?: string;
  contactName?: string;
  email?: string;
  phone?: string | null;
  internalReviewerEmail?: string | null;
  aiVoiceProfile?: Record<string, unknown>;
  aiCaptionExamples?: unknown[];
  loginPinHash?: string;
  pinLastGeneratedAt?: Date;
  pinExpiresAt?: Date | null;
};

export type CreateScheduleInput = {
  organizationId: string;
  officeId: string;
  clientId?: string | null;
  createdBy: string;
  title: string;
  reviewToken: string;
  reviewUrl?: string | null;
  layoutType?: string;
  status?: ContentScheduleStatus;
  reviewStatus?: string | null;
  scheduledAt?: Date | null;
  expiresAt?: Date | null;
  body?: string | null;
  captions?: string | null;
  notes?: string | null;
};

export type UpdateScheduleInput = Partial<{
  title: string;
  subtitle: string | null;
  body: string | null;
  summary: string | null;
  captions: string | null;
  notes: string | null;
  layoutType: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  reviewToken: string;
  reviewUrl: string | null;
  status: ContentScheduleStatus;
  reviewStatus: string | null;
  scheduledAt: Date | null;
  expiresAt: Date | null;
  clientId: string | null;
  assignedTo: string | null;
  lastViewedAt: Date | null;
  approvedAt: Date | null;
  approvedByName: string | null;
  approvedByEmail: string | null;
  changesRequestedAt: Date | null;
}>;

export type CreateClientMediaInput = {
  id?: string;
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
};

export type CreateScheduleAssetInput = {
  id?: string;
  scheduleId: string;
  organizationId: string;
  officeId: string;
  libraryMediaId?: string | null;
  uploadedBy: string;
  fileName: string;
  fileUrl: string;
  storagePath: string;
  bucket: string;
  mimeType?: string | null;
  assetType: string;
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
};

export type UpdateScheduleAssetInput = Partial<{
  heading: string | null;
  caption: string | null;
  isSelected: boolean;
  cropX: number | null;
  cropY: number | null;
  cropZoom: number | null;
  sortOrder: number;
  displaySlot: number;
}>;

export type ContentStore = {
  withReviewTransaction<T>(organizationId: string, scheduleId: string, work: (store: ContentStore) => Promise<T>): Promise<T>;
  listClients(organizationId: string, officeId: string): Promise<ContentClientRecord[]>;
  getClient(
    organizationId: string,
    officeId: string,
    clientId: string,
  ): Promise<ContentClientRecord | null>;
  getClientByPortalToken(
    portalToken: string,
    email: string,
  ): Promise<ContentClientRecord | null>;
  listSchedulesForClient(clientId: string): Promise<ContentScheduleRecord[]>;
  getScheduleForClient(
    clientId: string,
    scheduleId: string,
  ): Promise<ContentScheduleRecord | null>;
  createClient(input: CreateClientInput): Promise<ContentClientRecord>;
  updateClient(
    organizationId: string,
    officeId: string,
    clientId: string,
    input: UpdateClientInput,
  ): Promise<ContentClientRecord>;
  deleteClient(
    organizationId: string,
    officeId: string,
    clientId: string,
  ): Promise<void>;

  findScheduleForMonth(params: {
    organizationId: string;
    officeId: string;
    clientId: string;
    monthKey: string;
  }): Promise<ContentScheduleRecord | null>;
  listSchedules(params: {
    organizationId: string;
    officeId: string;
    clientId?: string;
    status?: ContentScheduleStatus | 'all';
    includeArchived?: boolean;
    limit?: number;
  }): Promise<ContentScheduleRecord[]>;
  getSchedule(
    organizationId: string,
    scheduleId: string,
  ): Promise<ContentScheduleRecord | null>;
  getScheduleByReviewToken(
    reviewToken: string,
  ): Promise<ContentScheduleRecord | null>;
  createSchedule(input: CreateScheduleInput): Promise<ContentScheduleRecord>;
  updateSchedule(
    organizationId: string,
    scheduleId: string,
    input: UpdateScheduleInput,
  ): Promise<ContentScheduleRecord>;
  deleteSchedule(organizationId: string, scheduleId: string): Promise<void>;

  listAssetsForSchedules(
    organizationId: string,
    scheduleIds: string[],
  ): Promise<ContentScheduleAssetRecord[]>;
  getAsset(
    organizationId: string,
    assetId: string,
  ): Promise<ContentScheduleAssetRecord | null>;
  createUploadedAsset(input: CreateScheduleAssetInput, clientId: string | null): Promise<ContentScheduleAssetRecord>;
  createAsset(input: CreateScheduleAssetInput): Promise<ContentScheduleAssetRecord>;
  updateAsset(
    organizationId: string,
    assetId: string,
    input: UpdateScheduleAssetInput,
  ): Promise<ContentScheduleAssetRecord>;
  setAssetsSelected(
    organizationId: string,
    assetIds: string[],
    isSelected: boolean,
  ): Promise<void>;
  deleteAsset(organizationId: string, assetId: string): Promise<ContentScheduleAssetRecord>;
  countAssetsUsingStoragePath(
    organizationId: string,
    storagePath: string,
  ): Promise<number>;
  findMediaOwnership(
    organizationId: string,
    storagePath: string,
  ): Promise<boolean>;

  listClientMedia(
    organizationId: string,
    clientId: string,
    page?: { limit?: number; before?: string; beforeId?: string },
  ): Promise<{ media: ContentClientMediaRecord[]; hasMore: boolean }>;
  getClientMedia(
    organizationId: string,
    mediaId: string,
  ): Promise<ContentClientMediaRecord | null>;
  createClientMedia(input: CreateClientMediaInput): Promise<ContentClientMediaRecord>;
  deleteClientMedia(
    organizationId: string,
    mediaId: string,
  ): Promise<ContentClientMediaRecord>;
  countLibraryRefs(organizationId: string, mediaId: string): Promise<number>;
  countClientMediaUsingPath(
    organizationId: string,
    storagePath: string,
  ): Promise<number>;

  listComments(
    organizationId: string,
    scheduleIds: string[],
  ): Promise<ContentCommentRecord[]>;
  listActivity(
    organizationId: string,
    scheduleIds: string[],
  ): Promise<ContentActivityRecord[]>;
  addComment(input: {
    scheduleId: string;
    organizationId: string;
    officeId: string;
    authorName: string;
    authorEmail?: string | null;
    body: string;
    createdBy?: string | null;
    displaySlot?: number | null;
    source?: string;
    visibility?: string;
    authorType?: string;
    commentType?: string;
    parentCommentId?: string | null;
  }): Promise<ContentCommentRecord>;

  recordActivity(input: {
    scheduleId: string;
    organizationId: string;
    officeId: string;
    actorUserId: string | null;
    activityType: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
};
