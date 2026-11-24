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

const accessOfficeA = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const accessOfficeB = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const accessForeignOffice = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const accessScheduleA = '11111111-2222-3333-4444-555555555555';
const accessScheduleB = '22222222-3333-4444-5555-666666666666';
const accessScheduleForeign = '33333333-4444-5555-6666-777777777777';
const accessAssetA = '44444444-5555-6666-7777-888888888888';
const accessAssetB = '55555555-6666-7777-8888-999999999999';

function accessSchedule(
  id: string,
  organizationId: string,
  officeId: string,
): ContentScheduleRecord {
  const now = new Date(0);
  return {
    id,
    organizationId,
    officeId,
    clientId: null,
    createdBy: userA,
    assignedTo: null,
    title: `Schedule ${id}`,
    subtitle: null,
    body: null,
    summary: null,
    captions: null,
    notes: null,
    layoutType: 'article',
    ctaLabel: null,
    ctaUrl: null,
    reviewToken: `review-${id}`,
    reviewUrl: null,
    slug: null,
    status: 'draft',
    reviewStatus: null,
    scheduledAt: null,
    expiresAt: null,
    approvedAt: null,
    approvedByName: null,
    approvedByEmail: null,
    changesRequestedAt: null,
    lastViewedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function accessAsset(
  id: string,
  scheduleId: string,
  organizationId: string,
  officeId: string,
): ContentScheduleAssetRecord {
  const now = new Date(0);
  return {
    id,
    scheduleId,
    organizationId,
    officeId,
    libraryMediaId: null,
    uploadedBy: userA,
    fileName: `${id}.mp4`,
    fileUrl: 'https://media.example.test/video.mp4',
    storagePath: `content/${id}.mp4`,
    bucket: 'content-review-assets',
    mimeType: 'video/mp4',
    assetType: 'video',
    heading: null,
    caption: null,
    isSelected: true,
    cropX: null,
    cropY: null,
    cropZoom: null,
    sortOrder: 0,
    displaySlot: 0,
    originalSizeBytes: 1,
    storedSizeBytes: 1,
    compressionStatus: 'stored_original',
    webPlaybackStatus: null,
    expiresAt: null,
    createdAt: now,
  };
}

function scheduleAccessFixture(
  context = authContext({
    membership: {
      officeId: accessOfficeA,
      roleKey: 'social_media',
      isAdminRole: false,
      permissions: { content_studio: { read: true, manage: true } },
    },
  }),
) {
  const schedules = [
    accessSchedule(accessScheduleA, orgA, accessOfficeA),
    accessSchedule(accessScheduleB, orgA, accessOfficeB),
    accessSchedule(accessScheduleForeign, orgB, accessForeignOffice),
  ];
  const assets = [
    accessAsset(accessAssetA, accessScheduleA, orgA, accessOfficeA),
    accessAsset(accessAssetB, accessScheduleB, orgA, accessOfficeB),
  ];
  const store = {
    async listSchedules(params: { organizationId: string; officeId: string }) {
      return schedules.filter(
        (schedule) =>
          schedule.organizationId === params.organizationId &&
          schedule.officeId === params.officeId,
      );
    },
    async getSchedule(organizationId: string, scheduleId: string) {
      return schedules.find(
        (schedule) =>
          schedule.organizationId === organizationId &&
          schedule.id === scheduleId,
      ) ?? null;
    },
    async listAssetsForSchedules(
      organizationId: string,
      scheduleIds: string[],
    ) {
      return assets.filter(
        (asset) =>
          asset.organizationId === organizationId &&
          scheduleIds.includes(asset.scheduleId),
      );
    },
    async listComments() {
      return [];
    },
    async listActivity() {
      return [];
    },
    async findMediaOwnership(
      organizationId: string,
      storagePath: string,
      officeId?: string,
    ) {
      return assets.some(
        (asset) =>
          asset.organizationId === organizationId &&
          asset.storagePath === storagePath &&
          (!officeId || asset.officeId === officeId),
      );
    },
  } as unknown as ContentStore;
  const directory = {
    async getOffice(organizationId: string, officeId: string) {
      if (
        organizationId !== orgA ||
        ![accessOfficeA, accessOfficeB].includes(officeId)
      ) {
        return null;
      }
      return {
        id: officeId,
        organizationId,
        name: officeId === accessOfficeA ? 'Head Office' : 'Branch Office',
        slug: officeId === accessOfficeA ? 'head-office' : 'branch-office',
        isPrimary: officeId === accessOfficeA,
        isActive: true,
        settings: {},
      };
    },
  } as unknown as OrganizationDirectoryStore;
  const app = createApp({
    content: store,
    organizationDirectory: directory,
    auth: {
      verifier: tokenService,
      resolveAuthContext: async () => context,
      requireActiveSession: sessionAuth.requireActiveSession,
    },
  });
  async function request(
    path: string,
    init: RequestInit = {},
  ) {
    const { authorization } = await sessionAuth.issueBearer(userA);
    const headers = new Headers(init.headers);
    headers.set('authorization', authorization);
    return app.request(path, { ...init, headers });
  }
  return { request };
}

test('social_media can list and read schedules and media in its assigned office', async () => {
  const f = scheduleAccessFixture();
  const listed = await f.request(
    `/api/content-studio/schedules?officeId=${accessOfficeA}`,
  );
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as {
    schedules: Array<{ id: string }>;
  };
  assert.deepEqual(listBody.schedules.map((schedule) => schedule.id), [
    accessScheduleA,
  ]);

  const detail = await f.request(
    `/api/content-studio/schedules/${accessScheduleA}`,
  );
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as {
    schedule: { id: string };
    assets: Array<{ id: string }>;
  };
  assert.equal(detailBody.schedule.id, accessScheduleA);
  assert.deepEqual(detailBody.assets.map((asset) => asset.id), [accessAssetA]);

  const assets = await f.request(
    `/api/content-studio/assets?scheduleIds=${accessScheduleA}`,
  );
  assert.equal(assets.status, 200);
  assert.deepEqual(
    ((await assets.json()) as { assets: Array<{ id: string }> }).assets.map(
      (asset) => asset.id,
    ),
    [accessAssetA],
  );

  const capability = await f.request('/api/content-studio/media/capability', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectKey: `content/${accessAssetA}.mp4` }),
  });
  assert.equal(capability.status, 200);

  const crossOfficeCapability = await f.request(
    '/api/content-studio/media/capability',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectKey: `content/${accessAssetB}.mp4` }),
    },
  );
  assert.equal(crossOfficeCapability.status, 404);
  assert.equal(
    ((await crossOfficeCapability.json()) as { error: { code: string } })
      .error.code,
    'CONTENT_MEDIA_NOT_FOUND',
  );
});

test('schedule list and detail reject unauthorized roles and office scopes', async () => {
  const unauthorized = scheduleAccessFixture(
    authContext({
      membership: {
        officeId: accessOfficeA,
        roleKey: 'employee',
        isAdminRole: false,
        permissions: {},
      },
    }),
  );
  for (const path of [
    `/api/content-studio/schedules?officeId=${accessOfficeA}`,
    `/api/content-studio/schedules/${accessScheduleA}`,
  ]) {
    const response = await unauthorized.request(path);
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'INSUFFICIENT_PERMISSION',
    );
  }

  const socialMedia = scheduleAccessFixture();
  for (const path of [
    `/api/content-studio/schedules?officeId=${accessOfficeB}`,
    `/api/content-studio/schedules/${accessScheduleB}`,
    `/api/content-studio/assets?scheduleIds=${accessScheduleB}`,
    `/api/content-studio/comments?scheduleIds=${accessScheduleB}`,
  ]) {
    const response = await socialMedia.request(path);
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'CONTENT_STUDIO_OFFICE_FORBIDDEN',
    );
  }

  const crossOrganization = await socialMedia.request(
    `/api/content-studio/schedules/${accessScheduleForeign}`,
  );
  assert.equal(crossOrganization.status, 404);
  assert.equal(
    ((await crossOrganization.json()) as { error: { code: string } }).error
      .code,
    'CONTENT_SCHEDULE_NOT_FOUND',
  );
});

test('missing office assignments return an actionable code and admins retain office selection', async () => {
  const unassigned = scheduleAccessFixture(
    authContext({
      membership: {
        officeId: null,
        roleKey: 'social_media',
        isAdminRole: false,
        permissions: { content_studio: { read: true } },
      },
    }),
  );
  const unassignedResponse = await unassigned.request(
    `/api/content-studio/schedules?officeId=${accessOfficeA}`,
  );
  assert.equal(unassignedResponse.status, 403);
  assert.equal(
    ((await unassignedResponse.json()) as { error: { code: string } }).error
      .code,
    'CONTENT_STUDIO_OFFICE_UNASSIGNED',
  );

  const admin = scheduleAccessFixture(
    authContext({
      membership: {
        officeId: accessOfficeA,
        roleKey: 'admin',
        isAdminRole: true,
        permissions: {},
      },
    }),
  );
  const adminResponse = await admin.request(
    `/api/content-studio/schedules?officeId=${accessOfficeB}`,
  );
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(
    ((await adminResponse.json()) as { schedules: Array<{ id: string }> })
      .schedules.map((schedule) => schedule.id),
    [accessScheduleB],
  );
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
