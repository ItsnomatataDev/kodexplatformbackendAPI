import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaPlaybackSignature as sign, verifyMediaPlaybackSignature as verify } from '../src/media-platform/playback/token.js';

const assetId = 'a1234567-1234-4123-8123-123456789abc';
const secret = 'isolated-test-key-not-for-deployment';
const expiresAt = 2000;
const signature = sign({ assetId, expiresAt }, secret);
const input = { assetId, expiresAt, signature, secret, now: 1000 };

test('playback signature round trip and UUID case normalization', () => {
  assert.deepEqual(verify(input), { valid: true, assetId, expiresAt });
  assert.equal(sign({ assetId: assetId.toUpperCase(), expiresAt }, secret), signature);
});

test('rejects tampering, other assets, wrong keys, missing and malformed signatures', () => {
  for (const patch of [
    { assetId: 'b1234567-1234-4123-8123-123456789abc' },
    { expiresAt: expiresAt + 1 }, { secret: 'another-key' }, { secret: '' },
    { signature: '' }, { signature: signature + '=' }, { signature: 'x'.repeat(43) },
  ]) assert.equal(verify({ ...input, ...patch }).valid, false);
});

test('expiry is exclusive and invalid expiry values fail closed', () => {
  assert.equal(verify({ ...input, now: expiresAt - 1 }).valid, true);
  for (const now of [expiresAt, expiresAt + 1]) {
    assert.deepEqual(verify({ ...input, now }), { valid: false, reason: 'expired' });
  }
  for (const expiry of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(verify({ ...input, expiresAt: expiry }).valid, false);
    assert.throws(() => sign({ assetId, expiresAt: expiry }, secret));
  }
});

test('invalid asset identifiers and missing signing secrets are rejected', () => {
  for (const id of ['', '../object', assetId + '\n', 'not-a-uuid']) {
    assert.equal(verify({ ...input, assetId: id }).valid, false);
    assert.throws(() => sign({ assetId: id, expiresAt }, secret));
  }
  assert.throws(() => sign({ assetId, expiresAt }, ''));
});
