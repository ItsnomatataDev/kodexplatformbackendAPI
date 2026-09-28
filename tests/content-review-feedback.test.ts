import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { internalFeedbackState, parseDisplaySlot } from '../src/content/portal.js';
import type { OrganizationDirectoryStore } from '../src/organizations/store.js';
import { hashClientSession } from '../src/content/pin.js';
import { submitInternalReview } from '../src/content/internal-review.js';
import type { ContentStore, ContentCommentRecord, ContentScheduleRecord, ContentScheduleAssetRecord } from '../src/content/store.js';
import { authContext, orgA, orgB, sessionAuth, tokenService, userA } from './work-harness.js';

const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const officeId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
function fixture() {
  let schedule = { id, organizationId: orgA, officeId, clientId: id, status: 'sent_to_client', reviewToken: 'review-token', expiresAt: null } as ContentScheduleRecord;
  const client = { id, organizationId: orgA, officeId, portalToken: 'portal', email: 'client@example.com', loginPinHash: 'hash', contactName: 'Client' };
  const comments: ContentCommentRecord[] = [];
  const assets = [0, 1].map((displaySlot) => ({ displaySlot, sortOrder: displaySlot, isSelected: true })) as ContentScheduleAssetRecord[];
  let ticks = 0;
  const store = {
    async withReviewTransaction<T>(_org: string, _id: string, work: (s: ContentStore) => Promise<T>) { return work(store); },
    async getSchedule(org: string) { return org === orgA ? schedule : null; },
    async getScheduleByReviewToken(token: string) { return token === 'review-token' ? schedule : null; },
    async getClientByPortalToken(token: string, email: string) { return token === client.portalToken && email === client.email ? client : null; },
    async getScheduleForClient(clientId: string) { return clientId === id ? schedule : null; },
    async listAssetsForSchedules() { return assets; },
    async listComments() { return [...comments]; },
    async addComment(input: object) { const comment = { ...input, id: String(++ticks), createdAt: new Date(Date.now() + ticks) } as ContentCommentRecord; comments.push(comment); return comment; },
    async updateSchedule(_org: string, _id: string, patch: object) { schedule = { ...schedule, ...patch }; return schedule; },
    async recordActivity() {},
  } as unknown as ContentStore;
  const app = createApp({ content: store, organizationDirectory: { async getOffice() { return { id: officeId, slug: 'its-no-matata' }; } } as unknown as OrganizationDirectoryStore, auth: { verifier: tokenService, resolveAuthContext: async () => authContext({ membership: { officeId } }), requireActiveSession: sessionAuth.requireActiveSession } });
  const credentials = { clientToken: client.portalToken, email: client.email, sessionToken: hashClientSession(client) };
  async function feedback(decision: string, post: number, overrides = {}) {
    const response = await app.request(`/api/content-studio/portal/reviews/${id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...credentials, decision, comment: `[Post ${post}] feedback`, ...overrides }) });
    return { response, data: await response.json() as any };
  }
  return { app, store, comments, assets, feedback, schedule: () => schedule };
}

test('display labels are one based and stored slots are zero based', () => {
  assert.equal(parseDisplaySlot('[Post 1] Approved'), 0);
  assert.equal(parseDisplaySlot('[Post 10] changes'), 9);
  assert.equal(parseDisplaySlot('[Post 0]'), null);
});

test('client approvals persist across posts; a change request can be approved again', async () => {
  const f = fixture();
  const first = await f.feedback('approved', 1);
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.data.feedback.approved_slots, [0]);
  assert.equal(f.schedule().status, 'sent_to_client');
  assert.equal((await f.feedback('approved', 1)).data.error, 'already_approved');
  assert.equal((await f.feedback('approved', 2)).data.status, 'approved');
  assert.equal((await f.feedback('changes_requested', 1)).data.status, 'changes_requested');
  assert.equal(f.schedule().approvedAt, null);
  assert.equal((await f.feedback('approved', 1)).data.status, 'approved');
});

test('client feedback rejects invalid sessions and out-of-schedule slots without writes', async () => {
  const f = fixture();
  assert.equal((await f.feedback('approved', 1, { sessionToken: 'bad' })).data.error, 'unauthorized');
  assert.equal((await f.feedback('approved', 3)).data.error, 'invalid_slot');
  assert.equal(f.comments.length, 0);
});

test('internal decisions stay separate from client approvals and clear revoked approval fields', async () => {
  const f = fixture();
  await f.feedback('approved', 1);
  const input = { store: f.store, organizationId: orgA, scheduleId: id, auth: authContext({ membership: { officeId } }), decision: 'approved', slot: 0, message: '[Post 1] approved' };
  assert.equal((await submitInternalReview(input)).ok, true);
  assert.equal(internalFeedbackState(f.assets, f.comments).all_posts_approved, false);
  assert.equal((await submitInternalReview({ ...input, slot: 1 })).status, 'approved');
  assert.equal((await submitInternalReview({ ...input, decision: 'changes_requested' })).status, 'ready_for_review');
  assert.equal(f.schedule().approvedAt, null);
  assert.equal((await submitInternalReview(input)).status, 'approved');
});

test('internal review requires matching organization, office and approver role', async () => {
  const f = fixture();
  const input = { store: f.store, organizationId: orgA, scheduleId: id, auth: authContext({ membership: { officeId } }), decision: 'approved', slot: 0, message: 'Approved' };
  assert.equal((await submitInternalReview({ ...input, organizationId: orgB })).ok, false);
  await assert.rejects(submitInternalReview({ ...input, auth: authContext() }), /office/);
  await assert.rejects(submitInternalReview({ ...input, auth: authContext({ membership: { officeId, roleKey: 'media_team' } }) }), /role/);
  assert.equal(f.comments.length, 0);
});

test('mounted internal feedback endpoint never permits anonymous writes', async () => {
  const f = fixture();
  const response = await f.app.request('/api/content-studio/internal-reviews/review-token/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slot: 0, decision: 'approved', message: 'Approved' }) });
  assert.equal(response.status, 401);
  assert.equal(f.comments.length, 0);
});

test('schedule-wide revocation clears slot approvals and permits fresh review', async () => {
  const f = fixture();
  await f.feedback('approved', 1);
  await f.feedback('approved', 2);
  const revoked = await f.feedback('revoke_approval', 1, { comment: 'Please reopen the whole schedule.' });
  assert.deepEqual(revoked.data.feedback.approved_slots, []);
  assert.equal((await f.feedback('approved', 1)).data.ok, true);
});


test('authenticated internal preview review persists through the mounted Kode route', async () => {
  const f = fixture();
  const { authorization } = await sessionAuth.issueBearer(userA);
  const response = await f.app.request('/api/content-studio/internal-reviews/review-token/feedback', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ slot: 0, decision: 'approved', message: '[Post 1] Approved' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.equal(result.ok, true);
  assert.equal(result.comment.authorType, 'internal');
  assert.deepEqual(result.feedback.approved_slots, [0]);
  const preview = await f.app.request('/api/content-studio/preview/review-token');
  const state = await preview.json() as any;
  assert.deepEqual(state.feedback.approved_slots, [0]);
});
