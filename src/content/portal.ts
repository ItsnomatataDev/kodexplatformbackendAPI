import type {
  ContentCommentRecord,
  ContentScheduleAssetRecord,
  ContentScheduleRecord,
  ContentScheduleStatus,
} from './store.js';

const REVIEWABLE_STATUSES = new Set<ContentScheduleStatus>([
  'sent_to_client',
  'viewed',
  'changes_requested',
  'published',
  'approved',
]);

export function portalCanReview(schedule: ContentScheduleRecord) {
  if (schedule.status === 'draft' || schedule.status === 'archived') return false;
  if (schedule.status === 'ready_for_review') return false;
  return REVIEWABLE_STATUSES.has(schedule.status);
}

export function parseDisplaySlot(body: string | null | undefined) {
  if (!body) return null;
  const match = body.match(/\[(?:post|slot)\s*[#:-]?\s*(\d+)\]/i);
  if (!match?.[1]) return null;
  const slot = Number(match[1]);
  return Number.isInteger(slot) && slot > 0 ? slot - 1 : null;
}

export function activeSlots(assets: ContentScheduleAssetRecord[]) {
  const slots = new Set<number>();
  for (const asset of assets) {
    if (asset.isSelected === false) continue;
    const slot = asset.displaySlot ?? asset.sortOrder ?? 0;
    if (slot >= 0) slots.add(slot);
  }
  return [...slots].sort((a, b) => a - b);
}

export function portalFeedbackState(params: {
  assets: ContentScheduleAssetRecord[];
  comments: ContentCommentRecord[];
  clientEmail: string;
}) {
  const slots = activeSlots(params.assets);
  const email = params.clientEmail.trim().toLowerCase();
  const clientComments = params.comments.filter(
    (comment) =>
      comment.authorType === 'client' &&
      (comment.authorEmail ?? '').trim().toLowerCase() === email,
  );

  const latestBySlot = new Map<number, ContentCommentRecord>();
  for (const comment of clientComments) {
    if (
      comment.commentType !== 'approval_note' &&
      comment.commentType !== 'change_request'
    ) {
      continue;
    }
    const slot = comment.source === 'client_portal'
      ? parseDisplaySlot(comment.body) ?? comment.displaySlot
      : comment.displaySlot ?? parseDisplaySlot(comment.body);
    // Schedule-wide decisions also reset per-post approval after revocation.
    for (const affectedSlot of slot == null ? slots : [slot]) {
      const existing = latestBySlot.get(affectedSlot);
      if (!existing || comment.createdAt >= existing.createdAt) {
        latestBySlot.set(affectedSlot, comment);
      }
    }
  }

  const approvedSlots: number[] = [];
  const changesRequestedSlots: number[] = [];
  for (const slot of slots) {
    const latest = latestBySlot.get(slot);
    if (!latest) continue;
    if (latest.commentType === 'approval_note') approvedSlots.push(slot);
    if (latest.commentType === 'change_request') changesRequestedSlots.push(slot);
  }

  const expectedPosts = slots.length;
  const approvedCount = approvedSlots.length;
  return {
    has_approved: approvedCount > 0,
    has_commented: clientComments.some((c) => c.commentType === 'client_comment'),
    has_requested_changes: changesRequestedSlots.length > 0,
    expected_posts: expectedPosts,
    approved_slots: approvedSlots,
    changes_requested_slots: changesRequestedSlots,
    approved_count: approvedCount,
    all_posts_approved: expectedPosts > 0 && approvedCount >= expectedPosts,
  };
}

/** Internal decisions aggregate across staff reviewers, independently of client decisions. */
export function internalFeedbackState(assets: ContentScheduleAssetRecord[], comments: ContentCommentRecord[]) {
  return portalFeedbackState({ assets, clientEmail: '', comments: comments
    .filter((comment) => comment.authorType === 'internal')
    .map((comment) => ({ ...comment, authorType: 'client', authorEmail: '' })) });
}
