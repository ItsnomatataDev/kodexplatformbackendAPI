/** Dedicated MinIO buckets for team chat media. */
export const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';
export const CHAT_IMAGES_BUCKET = 'chat-images';

export const CHAT_STORAGE_BUCKETS = [
  CHAT_ATTACHMENTS_BUCKET,
  CHAT_IMAGES_BUCKET,
] as const;

export type ChatStorageBucket = (typeof CHAT_STORAGE_BUCKETS)[number];

export function chatBucketForContentType(contentType: string | null | undefined) {
  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return CHAT_IMAGES_BUCKET;
  return CHAT_ATTACHMENTS_BUCKET;
}

export function chatObjectKey(params: {
  organizationId: string;
  conversationId: string;
  fileId: string;
  filename: string;
}) {
  const safe = params.filename
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120) || 'file.bin';
  return `${params.organizationId}/${params.conversationId}/${params.fileId}-${safe}`;
}
