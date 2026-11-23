import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaIngestUrl } from './ingest-url.js';
import { verifyMediaIngestRequest } from './ingest-auth.js';

const SECRET = 'test-only-media-ingest-secret';
const SESSION_ID = '0c8176a7-87c6-4f97-bf09-6c1fcf32acce';

test('accepts a signed ingest part path', () => {
  const minted = createMediaIngestUrl({
    sessionId: SESSION_ID,
    secret: SECRET,
    publicBaseUrl: 'https://media.tmctechsolutions.com',
  });
  const verified = verifyMediaIngestRequest({
    uri: `${minted.path}2`,
    secret: SECRET,
  });
  assert.equal(verified.valid, true);
  if (verified.valid) {
    assert.equal(verified.sessionId, SESSION_ID);
    assert.equal(verified.partNumber, 2);
  }
});

test('rejects playback paths and unsigned ingest paths', () => {
  const minted = createMediaIngestUrl({
    sessionId: SESSION_ID,
    secret: SECRET,
    publicBaseUrl: 'https://media.tmctechsolutions.com',
  });
  assert.equal(
    verifyMediaIngestRequest({
      uri: `/media/v2/1/${minted.signature}/${SESSION_ID}/1/hls/master.m3u8`,
      secret: SECRET,
    }).valid,
    false,
  );
  assert.equal(
    verifyMediaIngestRequest({
      uri: minted.path.replace(minted.signature, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') + '1',
      secret: SECRET,
    }).valid,
    false,
  );
});
