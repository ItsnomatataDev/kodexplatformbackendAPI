import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveStudioMediaSource,
  shouldRenewPlaybackGrant,
} from './studio-player.js';

test('uses the issued HTTPS grant only for ready video', () => {
  const proxy = '/api/content-studio/media?objectKey=org/photo.jpg';
  const playbackUrl = 'https://media.example.invalid/media/v2/1/sig/asset/17/hls/master.m3u8';
  assert.equal(
    resolveStudioMediaSource({
      kind: 'video',
      playbackReady: true,
      playbackUrl,
      proxyUrl: proxy,
    }),
    playbackUrl,
  );
  assert.equal(
    resolveStudioMediaSource({
      kind: 'video',
      playbackReady: false,
      playbackUrl,
      proxyUrl: proxy,
    }),
    proxy,
  );
  assert.equal(
    resolveStudioMediaSource({
      kind: 'image',
      playbackReady: true,
      playbackUrl: 'https://media.example.invalid/media/v2/1/sig/asset/17/image/original.jpg',
      proxyUrl: proxy,
    }),
    'https://media.example.invalid/media/v2/1/sig/asset/17/image/original.jpg',
  );
  assert.equal(
    resolveStudioMediaSource({
      kind: 'image',
      playbackReady: false,
      playbackUrl: 'https://media.example.invalid/media/v2/1/sig/asset/17/image/original.jpg',
      proxyUrl: proxy,
    }),
    proxy,
  );
});

test('renews a grant about 60 seconds before expiry', () => {
  assert.equal(shouldRenewPlaybackGrant(1_000, 940), true);
  assert.equal(shouldRenewPlaybackGrant(1_000, 900), false);
});
