/**
 * Binary attachments are stored decoded. JSON uploads send Base64, which is
 * 4/3 the binary size (plus padding). The HTTP body must therefore be larger
 * than MAX_ATTACHMENT_BYTES:
 *
 *   binary N bytes
 *     → Base64 length = 4 * ceil(N / 3)
 *     → JSON envelope (filename, contentType, keys) ≈ 1 KiB
 *     → MAX_REQUEST_BODY_BYTES >= Base64 length + envelope
 */
export const JSON_ENVELOPE_BYTES = 1024;

export const FIELD_LIMITS = {
  boardName: 120,
  boardDescription: 4_000,
  boardSlug: 80,
  boardStatus: 32,
  boardColor: 32,
  columnName: 80,
  columnColor: 32,
  columnStatusKey: 64,
  cardTitle: 200,
  cardDescription: 20_000,
  cardStatusKey: 64,
  cardPriority: 32,
  cardDepartment: 80,
  cardBlockedReason: 2_000,
  commentBody: 10_000,
  commentType: 32,
  labelName: 64,
  labelColor: 32,
  submissionTitle: 200,
  submissionNotes: 10_000,
  submissionType: 64,
  submissionUrl: 2_048,
  timeEntryNote: 2_000,
  filename: 255,
  contentType: 128,
  metadataMaxBytes: 8_192,
  metadataMaxDepth: 5,
  metadataMaxBreadth: 40,
} as const;

export function maxBase64LengthForBytes(maxBytes: number): number {
  return 4 * Math.ceil(maxBytes / 3);
}

export function minRequestBodyBytesForAttachment(maxAttachmentBytes: number): number {
  return maxBase64LengthForBytes(maxAttachmentBytes) + JSON_ENVELOPE_BYTES;
}

export type HttpLimits = {
  maxRequestBodyBytes: number;
  maxAttachmentBytes: number;
};

export type RateLimitPolicy = {
  limit: number;
  windowSeconds: number;
};

export type WorkRateLimitPolicies = {
  mutation: RateLimitPolicy;
  mutationOrg: RateLimitPolicy;
  mutationIp: RateLimitPolicy;
  attachment: RateLimitPolicy;
  attachmentOrg: RateLimitPolicy;
  attachmentIp: RateLimitPolicy;
};
