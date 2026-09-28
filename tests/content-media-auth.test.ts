import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { CONTENT_REVIEW_ASSETS_BUCKET } from '../src/content/buckets.js';
import { MediaCapabilityStore, mediaCapabilityStore } from '../src/content/media-capability.js';
import type { ContentStore } from '../src/content/store.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { authContext, orgA, orgB, sessionAuth, tokenService, userA } from './work-harness.js';

const objectKey = `${orgA}/test.png`;
const body = Buffer.from('test media');

async function fixture() {
  const files = new MemoryFileStorage();
  await files.putObject({ bucket: CONTENT_REVIEW_ASSETS_BUCKET, objectKey, body, contentType: 'image/png' });
  const lookups: string[][] = [];
  const content = {
    async findMediaOwnership(organizationId: string, key: string) {
      lookups.push([organizationId, key]);
      return organizationId === orgA && key === objectKey;
    },
  } as ContentStore;
  const app = createApp({
    content, files,
    auth: {
      verifier: tokenService,
      resolveAuthContext: async () => authContext(),
      requireActiveSession: sessionAuth.requireActiveSession,
    },
  });
  return { app, lookups };
}

test('mounted native GET serves media using only an issued opaque capability', async () => {
  const { app, lookups } = await fixture();
  const { authorization } = await sessionAuth.issueBearer(userA);
  const issued = await app.request('/api/content-studio/media/capability', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ objectKey }),
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const { url } = await issued.json() as { url: string };
  assert.match(url, /^\/api\/content-studio\/media\?cap=[\w-]+$/);
  const response = await app.request(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  assert.deepEqual(lookups, [[orgA, objectKey], [orgA, objectKey]]);
});

test('missing, invalid, and expired capabilities are rejected by the media route', async () => {
  const { app, lookups } = await fixture();
  const expired = mediaCapabilityStore.issue({ organizationId: orgA, objectKey }, -1);
  for (const query of ['', '?cap=invalid', `?cap=${expired}`, `?objectKey=${objectKey}&organizationId=${orgA}&jwt=fake`]) {
    const response = await app.request(`/api/content-studio/media${query}`);
    assert.equal(response.status, 403);
    const result = await response.json() as { error: { code: string } };
    assert.equal(result.error.code, 'CONTENT_MEDIA_FORBIDDEN');
  }
  assert.deepEqual(lookups, []);
});

test('capability ownership is rechecked and query values cannot override its scope', async () => {
  const { app, lookups } = await fixture();
  for (const grant of [{ organizationId: orgB, objectKey }, { organizationId: orgA, objectKey: `${orgA}/unknown.png` }]) {
    const cap = mediaCapabilityStore.issue(grant);
    const response = await app.request(`/api/content-studio/media?cap=${cap}&objectKey=${objectKey}&organizationId=${orgA}`);
    assert.equal(response.status, 404);
    assert.deepEqual(lookups.at(-1), [grant.organizationId, grant.objectKey]);
  }
});

test('capability issuance, other methods, and adjacent API paths still require Bearer auth', async () => {
  const { app } = await fixture();
  const cap = mediaCapabilityStore.issue({ organizationId: orgA, objectKey });
  for (const [method, path] of [
    ['POST', '/api/content-studio/media/capability'],
    ['POST', '/api/content-studio/media'],
    ['HEAD', '/api/content-studio/media'],
    ['GET', '/api/content-studio/media/'],
    ['GET', '/api/content-studio/media/other'],
    ['GET', '/api/content-studio/media/capability'],
    ['GET', '/api/me'],
  ]) {
    const response = await app.request(`${path}?cap=${cap}`, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test('capabilities permit repeated reads until expiry; retry fragments do not renew them', async (t) => {
  const { app } = await fixture();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cap = mediaCapabilityStore.issue({ organizationId: orgA, objectKey });
  const url = `/api/content-studio/media?cap=${cap}`;
  for (const fragment of ['', '#retry-1']) {
    const response = await app.request(url + fragment, { headers: { range: 'bytes=0-3' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 0-3/${body.length}`);
    assert.equal(await response.text(), 'test');
  }
  t.mock.timers.tick(60_000);
  assert.equal((await app.request(url + '#retry-2')).status, 403);
  const renewed = mediaCapabilityStore.issue({ organizationId: orgA, objectKey });
  assert.equal((await app.request(`/api/content-studio/media?cap=${renewed}`)).status, 200);
});

test('process-local capabilities do not survive replacing the store', () => {
  const issuingProcess = new MediaCapabilityStore();
  const cap = issuingProcess.issue({ organizationId: orgA, objectKey });
  assert.deepEqual(issuingProcess.consume(cap), { organizationId: orgA, objectKey });
  assert.equal(new MediaCapabilityStore().consume(cap), null);
});

for (const kind of ['schedule', 'client'] as const) {
  test(`${kind} binary upload -> authorized capability -> native Range playback`, async () => {
    const files = new MemoryFileStorage();
    const parentId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const officeId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const rows: Array<{ organizationId: string; storagePath: string }> = [];
    const content = {
      async getSchedule(organizationId: string, id: string) {
        return organizationId === orgA && id === parentId
          ? { id, organizationId, officeId, clientId: null } : null;
      },
      async getClient(organizationId: string, office: string, id: string) {
        return organizationId === orgA && office === officeId && id === parentId
          ? { id, organizationId, officeId } : null;
      },
      async createUploadedAsset(input: { organizationId: string; storagePath: string }) {
        rows.push(input);
        return { ...input, id: 'asset', createdAt: new Date() };
      },
      async createClientMedia(input: { organizationId: string; storagePath: string }) {
        rows.push(input);
        return { ...input, id: 'media', createdAt: new Date() };
      },
      async findMediaOwnership(organizationId: string, key: string) {
        return rows.some((row) => row.organizationId === organizationId && row.storagePath === key);
      },
    } as unknown as ContentStore;
    const app = createApp({
      content, files,
      auth: {
        verifier: tokenService,
        resolveAuthContext: async () => authContext({ membership: { officeId } }),
        requireActiveSession: sessionAuth.requireActiveSession,
      },
    });
    const { authorization } = await sessionAuth.issueBearer(userA);
    const uploadPath = kind === 'schedule'
      ? `/api/content-studio/schedules/${parentId}/assets/binary`
      : `/api/content-studio/clients/${parentId}/media/binary`;
    const upload = await app.request(`${uploadPath}?filename=clip.mov`, {
      method: 'POST', headers: { authorization, 'content-type': 'video/quicktime', 'content-length': String(body.length) },
      body: new Uint8Array(body),
    });
    assert.equal(upload.status, 201, await upload.clone().text());
    const result = await upload.json();
    const media = result.asset ?? result.media;
    assert.equal(media.mimeType, 'video/quicktime');
    assert.equal(media.bucket, CONTENT_REVIEW_ASSETS_BUCKET);
    assert.ok(media.storagePath.startsWith(kind === 'schedule' ? `${orgA}/${parentId}/` : `${orgA}/clients/${parentId}/`));
    const issued = await app.request('/api/content-studio/media/capability', {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ objectKey: media.storagePath }),
    });
    assert.equal(issued.status, 200);
    const { url } = await issued.json();
    const playback = await app.request(url, { headers: { range: 'bytes=0-3' } });
    assert.equal(playback.status, 206);
    assert.equal(playback.headers.get('content-type'), 'video/quicktime');
    assert.equal(playback.headers.get('content-length'), '4');
    assert.equal(playback.headers.get('accept-ranges'), 'bytes');
    assert.equal(playback.headers.get('content-range'), `bytes 0-3/${body.length}`);
    assert.equal(await playback.text(), 'test');
  });
}

for (const kind of ['schedule', 'client'] as const) {
  for (const encoding of ['binary', 'json'] as const) {
    test(`${kind} ${encoding} upload cleans up storage when metadata persistence fails`, async () => {
      const files = new MemoryFileStorage();
      const parentId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const officeId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      let failedKey = '';
      const fail = async (input: { storagePath: string }) => {
        failedKey = input.storagePath;
        assert(await files.getObject(CONTENT_REVIEW_ASSETS_BUCKET, failedKey));
        throw Error('database insert failed');
      };
      const content = {
        async getSchedule() { return { id: parentId, officeId, clientId: parentId }; },
        async getClient() { return { id: parentId, officeId }; },
        async createUploadedAsset(input: { storagePath: string }, clientId: string | null) {
          assert.equal(clientId, parentId);
          return fail(input);
        },
        createClientMedia: fail,
        async findMediaOwnership() { return false; },
      } as unknown as ContentStore;
      const app = createApp({ content, files, auth: {
        verifier: tokenService,
        resolveAuthContext: async () => authContext({ membership: { officeId } }),
        requireActiveSession: sessionAuth.requireActiveSession,
      } });
      const { authorization } = await sessionAuth.issueBearer(userA);
      const path = kind === 'schedule'
        ? `/api/content-studio/schedules/${parentId}/assets`
        : `/api/content-studio/clients/${parentId}/media`;
      const result = await app.request(path + (encoding === 'binary' ? '/binary?filename=test.png' : ''), {
        method: 'POST',
        headers: encoding === 'binary'
          ? { authorization, 'content-type': 'image/png', 'content-length': String(body.length) }
          : { authorization, 'content-type': 'application/json' },
        body: encoding === 'binary' ? new Uint8Array(body)
          : JSON.stringify({ filename: 'test.png', contentType: 'image/png', contentBase64: body.toString('base64') }),
      });
      assert.equal(result.status, 500);
      assert(failedKey, 'metadata persistence was attempted');
      assert.equal(await files.getObject(CONTENT_REVIEW_ASSETS_BUCKET, failedKey), null);
    });
  }
}

test('issued playback grants support seeking after the former one-minute expiry', async (t) => {
  const { app } = await fixture();
  const { authorization } = await sessionAuth.issueBearer(userA);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const response = await app.request('/api/content-studio/media/capability', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ objectKey }),
  });
  const { url, expiresIn } = await response.json() as { url: string; expiresIn: number };
  assert.equal(expiresIn, 3600);
  t.mock.timers.tick(61_000);
  const seek = await app.request(url, { headers: { range: 'bytes=-4' } });
  assert.equal(seek.status, 206);
  assert.equal(await seek.text(), 'edia');
  t.mock.timers.tick(3_600_000);
  assert.equal((await app.request(url)).status, 403);
});

test('one issued URL supports sequential ranges and forward/backward seeking', async () => {
  const { app } = await fixture();
  const { authorization } = await sessionAuth.issueBearer(userA);
  const issued = await app.request('/api/content-studio/media/capability', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ objectKey }),
  });
  const { url } = await issued.json();
  for (const [range, start, end] of [
    ['bytes=0-2', 0, 2], ['bytes=3-5', 3, 5], ['bytes=6-', 6, 9],
    ['bytes=1-3', 1, 3], ['bytes=-2', 8, 9], ['bytes=8-99', 8, 9],
  ] as const) {
    const response = await app.request(url, { headers: { range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${body.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body.subarray(start, end + 1));
  }
  for (const range of ['bytes=100-', 'bytes=5-2', 'invalid']) {
    const response = await app.request(url, { headers: { range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${body.length}`);
    assert.equal(await response.text(), '');
  }
});
