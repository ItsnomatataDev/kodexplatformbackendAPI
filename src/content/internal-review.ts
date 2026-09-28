import type { AuthContext } from '../authorization/types.js';
import { ForbiddenError } from '../http/errors.js';
import { internalFeedbackState } from './portal.js';
import type { ContentStore, UpdateScheduleInput } from './store.js';

export async function submitInternalReview(input: {
  store: ContentStore;
  organizationId: string;
  scheduleId: string;
  auth: AuthContext;
  slot: number;
  decision: string;
  message: string;
}) {
  const { auth, organizationId, scheduleId, slot, decision, message } = input;
  const roles = new Set(['admin', 'org_admin', 'super_admin', 'superadmin', 'social_media', 'manager', 'it', 'it-superadmin']);
  if (!roles.has(auth.membership.roleKey ?? '')) {
    throw new ForbiddenError('CONTENT_REVIEW_FORBIDDEN', 'Your role cannot approve schedules.');
  }
  return input.store.withReviewTransaction(organizationId, scheduleId, async (store) => {
    const schedule = await store.getSchedule(organizationId, scheduleId);
    if (!schedule) return { ok: false as const, error: 'not_found' };
    if (schedule.officeId !== auth.membership.officeId) {
      throw new ForbiddenError('CONTENT_REVIEW_FORBIDDEN', 'Reviewers must belong to the schedule office.');
    }
    if (schedule.expiresAt && schedule.expiresAt.getTime() < Date.now()) return { ok: false as const, error: 'expired' };
    if (['published', 'archived'].includes(schedule.status)) return { ok: false as const, error: 'read_only' };
    if (!['approved', 'changes_requested'].includes(decision)) return { ok: false as const, error: 'invalid_decision' };
    const [assets, comments] = await Promise.all([
      store.listAssetsForSchedules(organizationId, [scheduleId]),
      store.listComments(organizationId, [scheduleId]),
    ]);
    if (!Number.isInteger(slot) || slot < 0 || !assets.some((a) => a.isSelected !== false && (a.displaySlot ?? a.sortOrder) === slot)) {
      return { ok: false as const, error: 'invalid_slot' };
    }
    if (decision === 'approved' && internalFeedbackState(assets, comments).approved_slots.includes(slot)) {
      return { ok: false as const, error: 'already_approved' };
    }
    const comment = await store.addComment({
      scheduleId, organizationId, officeId: schedule.officeId,
      authorName: auth.actor.email ?? 'Staff', authorEmail: auth.actor.email,
      createdBy: auth.actor.userId, body: message, displaySlot: slot,
      source: 'internal', visibility: 'internal', authorType: 'internal',
      commentType: decision === 'approved' ? 'approval_note' : 'change_request',
    });
    const feedback = internalFeedbackState(assets, [...comments, comment]);
    const patch: UpdateScheduleInput = {};
    if (decision === 'changes_requested') {
      Object.assign(patch, { status: 'ready_for_review', reviewStatus: 'ready_for_review',
        changesRequestedAt: new Date(), approvedAt: null, approvedByName: null, approvedByEmail: null });
    } else if (feedback.all_posts_approved) {
      Object.assign(patch, { status: 'approved', reviewStatus: 'approved', approvedAt: new Date(),
        approvedByName: auth.actor.email ?? 'Staff', approvedByEmail: auth.actor.email, changesRequestedAt: null });
    }
    const updated = Object.keys(patch).length ? await store.updateSchedule(organizationId, scheduleId, patch) : schedule;
    await store.recordActivity({ scheduleId, organizationId, officeId: schedule.officeId,
      actorUserId: auth.actor.userId, activityType: decision === 'approved' ? 'internal_approval' : 'internal_changes_requested',
      metadata: { display_slot: slot, comment_id: comment.id } });
    return { ok: true as const, status: updated.status, comment, feedback };
  });
}
