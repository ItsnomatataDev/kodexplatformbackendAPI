import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { errorHandler } from '../src/middleware/error-handler.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { PROFILE_PICTURES_BUCKET } from '../src/organizations/buckets.js';
import {
  MemoryOrganizationDirectoryStore,
  seedActiveMember,
} from '../src/organizations/memory-store.js';
import { createOrganizationRoutes } from '../src/routes/organization.js';
import type { AuthContext } from '../src/authorization/types.js';
import '../src/types/hono.js';
import { bodyLimitMiddleware } from '../src/middleware/body-limit.js';
import { createMeRoutes } from '../src/routes/me.js';

const ownerId = '22222222-2222-2222-2222-222222222222';
const organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function createAvatarApp(
  store: MemoryOrganizationDirectoryStore,
  files: MemoryFileStorage,
  auth: AuthContext,
) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', bodyLimitMiddleware(16 * 1024 * 1024));
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route(
    '/api/organization',
    createOrganizationRoutes({
      store,
      files,
      sendInvitation: async () => {},
    }),
  );
  return app;
}

function memberContext(): AuthContext {
  return {
    actor: {
      userId: '11111111-1111-1111-1111-111111111111',
      email: 'member@example.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId,
      officeId: null,
      roleId: null,
      roleKey: 'employee',
      status: 'active',
      isAdminRole: false,
      isManagerRole: false,
      permissions: {},
    },
    organization: {
      organizationId,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

test('active organization members can read another active member avatar', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedActiveMember(store, { organizationId, userId: ownerId });
  const files = new MemoryFileStorage();
  await files.putObject({
    bucket: PROFILE_PICTURES_BUCKET,
    objectKey: `${ownerId}/legacy-image`,
    body: Buffer.from('avatar-bytes'),
    contentType: 'image/jpeg',
  });
  const app = createAvatarApp(store, files, memberContext());

  const response = await app.request(
    `/api/organization/avatar/file?objectKey=${encodeURIComponent(`${ownerId}/legacy-image`)}`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(await response.text(), 'avatar-bytes');
});

test('avatar reads do not expose profiles outside the active organization', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedActiveMember(store, {
    organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    userId: ownerId,
  });
  const files = new MemoryFileStorage();
  await files.putObject({
    bucket: PROFILE_PICTURES_BUCKET,
    objectKey: `${ownerId}/legacy-image`,
    body: Buffer.from('avatar-bytes'),
    contentType: 'image/jpeg',
  });
  const app = createAvatarApp(store, files, memberContext());

  const response = await app.request(
    `/api/organization/avatar/file?objectKey=${encodeURIComponent(`${ownerId}/legacy-image`)}`,
  );

  assert.equal(response.status, 404);
});

test('avatar reads reject object keys that escape the user namespace', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  seedActiveMember(store, { organizationId, userId: ownerId });
  const app = createAvatarApp(store, new MemoryFileStorage(), memberContext());

  const response = await app.request(
    `/api/organization/avatar/file?objectKey=${encodeURIComponent(`${ownerId}/../other-user/avatar.jpg`)}`,
  );

  assert.equal(response.status, 400);
});

test('a replacement avatar upload persists an API URL and can be read by a colleague', async () => {
  const store = new MemoryOrganizationDirectoryStore();
  const auth = memberContext();
  seedActiveMember(store, { organizationId, userId: auth.actor.userId });
  const files = new MemoryFileStorage();
  const app = createAvatarApp(store, files, auth);
  let avatarUrl: string | null = null;
  app.route('/api/me', createMeRoutes({
    files,
    loadPublicProfile: async () => null,
    updatePublicProfile: async (_userId, patch) => {
      avatarUrl = patch.avatarUrl ?? null;
      return { fullName: 'Test Member', avatarUrl, jobTitle: null,
        department: null, employeeCode: null, username: null };
    },
  }));
  const bytes = Buffer.from('replacement-avatar');
  const upload = await app.request('/api/me/avatar/binary?filename=photo.png', {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) },
    body: bytes,
  });
  assert.equal(upload.status, 201);
  const result = await upload.json();
  assert.equal(avatarUrl, result.publicUrl);
  assert.ok(result.publicUrl.startsWith('/api/organization/avatar/file?'));
  const colleague = memberContext();
  colleague.actor.userId = ownerId;
  const reader = createAvatarApp(store, files, colleague);
  const image = await reader.request(result.publicUrl);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
});

test('avatar uploads accept 10 MB and reject larger or invalid images', async () => {
  const files = new MemoryFileStorage();
  const app = createAvatarApp(new MemoryOrganizationDirectoryStore(), files, memberContext());
  app.route('/api/me', createMeRoutes({ files, loadPublicProfile: async () => null }));
  const upload = (size: number, type = 'image/png') => app.request('/api/me/avatar/binary', {
    method: 'POST', headers: { 'content-type': type, 'content-length': String(size) },
    body: Buffer.alloc(size),
  });
  assert.equal((await upload(10 * 1024 * 1024)).status, 201);
  assert.equal((await upload(10 * 1024 * 1024 + 1)).status, 413);
  assert.equal((await upload(10, 'text/html')).status, 400);
  const dishonest = await app.request('/api/me/avatar/binary', {
    method: 'POST', headers: { 'content-type': 'image/png', 'content-length': '1' },
    body: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  assert.equal(dishonest.status, 413);
});
