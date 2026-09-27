/** Dedicated MinIO bucket for Content Studio media. */
export const CONTENT_REVIEW_ASSETS_BUCKET = 'content-review-assets';

export const CONTENT_STORAGE_BUCKETS = [CONTENT_REVIEW_ASSETS_BUCKET] as const;

export type ContentStorageBucket = (typeof CONTENT_STORAGE_BUCKETS)[number];

export const CONTENT_ASSET_KEEP_UNTIL = new Date('2099-12-31T00:00:00.000Z');

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._\-()[\] ]+/g, '_').slice(0, 180) || 'file.bin';
}

export function contentScheduleObjectKey(params: {
  organizationId: string;
  scheduleId: string;
  fileId: string;
  filename: string;
}) {
  return `${params.organizationId}/${params.scheduleId}/${params.fileId}-${safeFilename(params.filename)}`;
}

export function contentClientObjectKey(params: {
  organizationId: string;
  clientId: string;
  fileId: string;
  filename: string;
}) {
  return `${params.organizationId}/clients/${params.clientId}/${params.fileId}-${safeFilename(params.filename)}`;
}

export function contentAssetTypeFromMime(mimeType: string | null | undefined) {
  const type = (mimeType ?? '').toLowerCase();
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  return 'image';
}
