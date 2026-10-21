import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPlaybackGrantStore } from './redis-grant.js';
import { ServiceUnavailableError } from '../../http/errors.js';

const grant = {
  signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  assetId: '0c8176a7-87c6-4f97-bf09-6c1fcf32acce',
  generation: '17',
  organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  userId: '11111111-1111-1111-1111-111111111111',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

test('issues, reads, and revokes a memory playback grant', async () => {
  const store = new MemoryPlaybackGrantStore();
  await store.issue(grant, 300_000);
  const found = await store.get(grant.signature);
  assert.equal(found?.assetId, grant.assetId);
  assert.equal(found?.generation, '17');
  await store.revokeUser(grant.userId);
  assert.equal(await store.get(grant.signature), null);
});

test('expired grants are not returned', async () => {
  const store = new MemoryPlaybackGrantStore();
  await store.issue(grant, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.get(grant.signature), null);
});

test('rejects an invalid grant payload', async () => {
  const store = new MemoryPlaybackGrantStore();
  await assert.rejects(
    () => store.issue({ ...grant, signature: 'short' }, 300_000),
    ServiceUnavailableError,
  );
});
