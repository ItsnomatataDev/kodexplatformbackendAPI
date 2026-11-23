import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthContext } from '../src/authorization/types.js';
import { workspaceAccess } from '../src/ai/role-access.js';
import { buildWorkspaceBrief } from '../src/ai/workspace-brief.js';

const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const adminId = '11111111-1111-1111-1111-111111111111';
const mediaId = '22222222-2222-2222-2222-222222222222';
const otherId = '33333333-3333-3333-3333-333333333333';

function auth(partial: {
  userId: string;
  roleKey: string;
  isAdminRole?: boolean;
  isManagerRole?: boolean;
  permissions?: Record<string, unknown>;
}): AuthContext {
  return {
    actor: {
      userId: partial.userId,
      email: 'person@example.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId: org,
      officeId: null,
      roleId: 'role-1',
      roleKey: partial.roleKey,
      status: 'active',
      isAdminRole: partial.isAdminRole ?? false,
      isManagerRole: partial.isManagerRole ?? false,
      permissions: partial.permissions ?? {},
    },
    organization: {
      organizationId: org,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

const staffPermissions = {
  attendance: { read: true, clock: true },
  leave: { read: true, request: true },
  tickets: { read: true },
  documents: { read: true },
  chat: { read: true, write: true },
  work: { boards: { read: true }, cards: { read: true } },
  duty_roster: { read: true },
  media: { read: true, manage: true },
  organization: { branding_read: true },
};

test('admin can see every workspace area', () => {
  const access = workspaceAccess(auth({
    userId: adminId,
    roleKey: 'admin',
    isAdminRole: true,
  }));
  assert.equal(access.admin, true);
  assert.equal(access.areas.includes('attendance_team'), true);
  assert.equal(access.areas.includes('security'), true);
  assert.equal(access.areas.includes('documents_manage'), true);
});

test('media team cannot see the team clock-in list', () => {
  const access = workspaceAccess(auth({
    userId: mediaId,
    roleKey: 'media_team',
    permissions: staffPermissions,
  }));
  assert.equal(access.areas.includes('attendance_own'), true);
  assert.equal(access.areas.includes('attendance_team'), false);
  assert.equal(access.areas.includes('security'), false);
  assert.equal(access.areas.includes('content_studio'), false);
});

test('social media can approve Content Studio and still cannot see team attendance', () => {
  const access = workspaceAccess(auth({
    userId: mediaId,
    roleKey: 'social_media',
    permissions: {
      ...staffPermissions,
      content_studio: { read: true, manage: true, approve: true },
    },
  }));
  assert.equal(access.areas.includes('content_studio_approve'), true);
  assert.equal(access.areas.includes('attendance_team'), false);
});

test('manager can see team attendance and cannot see the security center', () => {
  const access = workspaceAccess(auth({
    userId: adminId,
    roleKey: 'manager',
    isManagerRole: true,
    permissions: staffPermissions,
  }));
  assert.equal(access.areas.includes('attendance_team'), true);
  assert.equal(access.areas.includes('security'), false);
});

test('a non-manager prompt does not include another person clocking in', async () => {
  const brief = await buildWorkspaceBrief(
    auth({
      userId: mediaId,
      roleKey: 'media_team',
      permissions: staffPermissions,
    }),
    {
      attendance: {
        async listMembers() {
          return [
            { userId: mediaId, fullName: 'Media Person', email: null, roleKey: 'media_team' },
            { userId: otherId, fullName: 'Secret Colleague', email: null, roleKey: 'seo_specialist' },
          ];
        },
        async listSessions(input) {
          assert.equal(input.userId, mediaId);
          return [
            {
              userId: otherId,
              userName: 'Secret Colleague',
              clockInAt: new Date('2026-11-10T06:00:00Z'),
              clockOutAt: null,
              status: 'active',
            },
            {
              userId: mediaId,
              userName: 'Media Person',
              clockInAt: new Date('2026-11-10T07:00:00Z'),
              clockOutAt: null,
              status: 'active',
            },
          ];
        },
      },
    },
  );
  assert.match(brief, /You:/);
  assert.equal(brief.includes('Secret Colleague'), false);
});

test('an admin prompt includes who clocked in', async () => {
  const brief = await buildWorkspaceBrief(
    auth({
      userId: adminId,
      roleKey: 'admin',
      isAdminRole: true,
    }),
    {
      attendance: {
        async listMembers() {
          return [
            { userId: adminId, fullName: 'Ada Admin', email: null, roleKey: 'admin' },
            { userId: otherId, fullName: 'Secret Colleague', email: null, roleKey: 'seo_specialist' },
          ];
        },
        async listSessions() {
          return [{
            userId: otherId,
            userName: null,
            clockInAt: new Date('2026-11-10T06:00:00Z'),
            clockOutAt: null,
            status: 'active',
          }];
        },
      },
    },
  );
  assert.match(brief, /Secret Colleague/);
  assert.match(brief, /Ada Admin/);
  assert.match(brief, /full workspace access/);
});
